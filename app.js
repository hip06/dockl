/* ================================================================
   DocKL — Story Reading App
   Application Logic — IndexedDB Storage
   ================================================================ */

(() => {
  'use strict';

  // ==================== CONSTANTS ====================
  const DB_NAME = 'dockl_db';
  const DB_VERSION = 1;
  const SETTINGS_KEY = 'dockl_settings';
  const GRADIENTS = [
    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
    'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
    'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',
    'linear-gradient(135deg, #e0c3fc 0%, #8ec5fc 100%)',
    'linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)',
    'linear-gradient(135deg, #0c3483 0%, #a2b6df 100%)',
    'linear-gradient(135deg, #fc5c7d 0%, #6a82fb 100%)',
    'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)',
  ];

  const DEFAULT_SETTINGS = {
    fontSize: 18,
    fontFamily: 'sans',
    theme: 'dark',
    lineHeight: 1.8,
  };

  // ==================== UTILITIES ====================
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  function countWords(text) {
    if (!text || !text.trim()) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function estimateReadingTime(wordCount) {
    const minutes = Math.ceil(wordCount / 200);
    if (minutes < 1) return '< 1 phút';
    return `${minutes} phút`;
  }

  function getInitials(title) {
    return title.split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('');
  }

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  function escapeHtml(text) {
    const el = document.createElement('div');
    el.textContent = text;
    return el.innerHTML;
  }

  function textToHtml(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const paragraphs = escaped.split(/\n\s*\n/);
    if (paragraphs.length > 1) {
      return paragraphs
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
    }
    return escaped
      .split(/\n/)
      .filter(l => l.trim())
      .map(l => `<p>${l.trim()}</p>`)
      .join('\n');
  }

  // ==================== IndexedDB DATA STORE ====================
  // Two object stores:
  //   "stories" — metadata only (no chapter content), keyed by id
  //   "chapters" — individual chapter records, keyed by id, indexed by storyId + order
  //
  // Story record:
  //   { id, title, author, description, coverGradient, chapterIds:[], lastReadChapter, lastReadScroll, createdAt, updatedAt }
  //
  // Chapter record:
  //   { id, storyId, order, title, content, wordCount, createdAt, updatedAt }

  const DataStore = {
    _db: null,

    // --- Open / Initialize DB ---
    open() {
      return new Promise((resolve, reject) => {
        if (this._db) { resolve(this._db); return; }

        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (e) => {
          const db = e.target.result;

          if (!db.objectStoreNames.contains('stories')) {
            db.createObjectStore('stories', { keyPath: 'id' });
          }

          if (!db.objectStoreNames.contains('chapters')) {
            const chStore = db.createObjectStore('chapters', { keyPath: 'id' });
            chStore.createIndex('storyId', 'storyId', { unique: false });
            chStore.createIndex('storyId_order', ['storyId', 'order'], { unique: false });
          }
        };

        req.onsuccess = (e) => {
          this._db = e.target.result;
          resolve(this._db);
        };

        req.onerror = (e) => {
          console.error('IndexedDB open error:', e.target.error);
          reject(e.target.error);
        };
      });
    },

    // --- Low-level helpers ---
    _tx(storeNames, mode = 'readonly') {
      const tx = this._db.transaction(storeNames, mode);
      return tx;
    },

    _store(storeName, mode = 'readonly') {
      return this._tx(storeName, mode).objectStore(storeName);
    },

    _request(idbRequest) {
      return new Promise((resolve, reject) => {
        idbRequest.onsuccess = () => resolve(idbRequest.result);
        idbRequest.onerror = () => reject(idbRequest.error);
      });
    },

    // Perform a multi-store transaction atomically
    _multiTx(storeNames, mode, callback) {
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction(storeNames, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        result = callback(tx);
      });
    },

    // --- Stories CRUD ---
    async getStories() {
      const store = this._store('stories');
      const stories = await this._request(store.getAll());
      // Sort by createdAt descending (newest first) as default
      stories.sort((a, b) => b.createdAt - a.createdAt);
      return stories;
    },

    async getStory(id) {
      const store = this._store('stories');
      return await this._request(store.get(id)) || null;
    },

    // Get story with its chapters populated (for detail/reader views)
    async getStoryWithChapters(id) {
      const tx = this._tx(['stories', 'chapters']);
      const story = await this._request(tx.objectStore('stories').get(id));
      if (!story) return null;

      const index = tx.objectStore('chapters').index('storyId');
      const chapters = await this._request(index.getAll(id));
      // Sort by order
      chapters.sort((a, b) => a.order - b.order);
      story.chapters = chapters;
      return story;
    },

    async addStory(storyData) {
      const now = Date.now();
      const story = {
        id: generateId(),
        title: storyData.title,
        author: storyData.author || '',
        description: storyData.description || '',
        coverGradient: storyData.coverGradient ?? 0,
        chapterCount: 0,
        totalWords: 0,
        lastReadChapter: -1,
        lastReadScroll: 0,
        createdAt: now,
        updatedAt: now,
      };
      const store = this._store('stories', 'readwrite');
      await this._request(store.put(story));
      return story;
    },

    async updateStory(id, updates) {
      const store = this._store('stories', 'readwrite');
      const story = await this._request(store.get(id));
      if (!story) return null;
      Object.assign(story, updates, { updatedAt: Date.now() });
      // Don't allow chapters array to leak into story record
      delete story.chapters;
      await this._request(store.put(story));
      return story;
    },

    async deleteStory(id) {
      return this._multiTx(['stories', 'chapters'], 'readwrite', (tx) => {
        // Delete story
        tx.objectStore('stories').delete(id);
        // Delete all chapters belonging to this story
        const chStore = tx.objectStore('chapters');
        const index = chStore.index('storyId');
        const req = index.openCursor(id);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      });
    },

    // --- Chapters CRUD ---
    async getChapters(storyId) {
      const index = this._store('chapters').index('storyId');
      const chapters = await this._request(index.getAll(storyId));
      chapters.sort((a, b) => a.order - b.order);
      return chapters;
    },

    async getChapter(chapterId) {
      const store = this._store('chapters');
      return await this._request(store.get(chapterId)) || null;
    },

    async addChapter(storyId, chapterData) {
      const now = Date.now();

      // Get current chapter count for ordering
      const existingChapters = await this.getChapters(storyId);
      const nextOrder = existingChapters.length;
      const wordCount = countWords(chapterData.content);

      const chapter = {
        id: generateId(),
        storyId,
        order: nextOrder,
        title: chapterData.title,
        content: chapterData.content || '',
        wordCount,
        createdAt: now,
        updatedAt: now,
      };

      // Add chapter and update story stats in one transaction
      await this._multiTx(['stories', 'chapters'], 'readwrite', (tx) => {
        tx.objectStore('chapters').put(chapter);

        // Update story metadata
        const storyStore = tx.objectStore('stories');
        const getReq = storyStore.get(storyId);
        getReq.onsuccess = () => {
          const story = getReq.result;
          if (story) {
            story.chapterCount = nextOrder + 1;
            story.totalWords = (story.totalWords || 0) + wordCount;
            story.updatedAt = now;
            storyStore.put(story);
          }
        };
      });

      return chapter;
    },

    async updateChapter(storyId, chapterId, updates) {
      return this._multiTx(['stories', 'chapters'], 'readwrite', async (tx) => {
        const chStore = tx.objectStore('chapters');
        const storyStore = tx.objectStore('stories');

        const getChReq = chStore.get(chapterId);
        getChReq.onsuccess = () => {
          const ch = getChReq.result;
          if (!ch) return;

          const oldWordCount = ch.wordCount || 0;
          Object.assign(ch, updates, { updatedAt: Date.now() });
          if (updates.content !== undefined) {
            ch.wordCount = countWords(ch.content);
          }
          chStore.put(ch);

          // Update story totalWords if content changed
          if (updates.content !== undefined) {
            const getStReq = storyStore.get(storyId);
            getStReq.onsuccess = () => {
              const story = getStReq.result;
              if (story) {
                story.totalWords = (story.totalWords || 0) - oldWordCount + ch.wordCount;
                story.updatedAt = Date.now();
                storyStore.put(story);
              }
            };
          }
        };
      });
    },

    async deleteChapter(storyId, chapterId) {
      await this._multiTx(['stories', 'chapters'], 'readwrite', (tx) => {
        const chStore = tx.objectStore('chapters');
        const storyStore = tx.objectStore('stories');

        // Get chapter first to know its wordCount
        const getReq = chStore.get(chapterId);
        getReq.onsuccess = () => {
          const ch = getReq.result;
          if (!ch) return;

          chStore.delete(chapterId);

          // Reorder remaining chapters
          const index = chStore.index('storyId');
          const allReq = index.getAll(storyId);
          allReq.onsuccess = () => {
            const remaining = allReq.result
              .filter(c => c.id !== chapterId)
              .sort((a, b) => a.order - b.order);
            remaining.forEach((c, i) => {
              if (c.order !== i) {
                c.order = i;
                chStore.put(c);
              }
            });

            // Update story metadata
            const getStReq = storyStore.get(storyId);
            getStReq.onsuccess = () => {
              const story = getStReq.result;
              if (story) {
                story.chapterCount = remaining.length;
                story.totalWords = Math.max(0, (story.totalWords || 0) - (ch.wordCount || 0));
                if (story.lastReadChapter >= remaining.length) {
                  story.lastReadChapter = Math.max(0, remaining.length - 1);
                }
                story.updatedAt = Date.now();
                storyStore.put(story);
              }
            };
          };
        };
      });
    },

    // --- Reading Position ---
    async saveReadPosition(storyId, chapterIndex, scroll) {
      const store = this._store('stories', 'readwrite');
      const story = await this._request(store.get(storyId));
      if (!story) return;
      story.lastReadChapter = chapterIndex;
      story.lastReadScroll = scroll || 0;
      await this._request(store.put(story));
    },

    // --- Settings (stays in LocalStorage — tiny data) ---
    getSettings() {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    },

    saveSettings(settings) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch { /* ignore */ }
    },

    // --- Export / Import ---
    async exportData() {
      const stories = await this.getStories();
      const allChapters = await this._request(this._store('chapters').getAll());

      // Rebuild the old flat format for compatibility
      const exportStories = stories.map(s => {
        const chapters = allChapters
          .filter(ch => ch.storyId === s.id)
          .sort((a, b) => a.order - b.order)
          .map(ch => ({
            id: ch.id,
            title: ch.title,
            content: ch.content,
            createdAt: ch.createdAt,
            updatedAt: ch.updatedAt,
          }));

        return {
          id: s.id,
          title: s.title,
          author: s.author,
          description: s.description,
          coverGradient: s.coverGradient,
          chapters,
          lastReadChapter: s.lastReadChapter,
          lastReadScroll: s.lastReadScroll,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        };
      });

      return JSON.stringify({ stories: exportStories, settings: this.getSettings() }, null, 2);
    },

    async importData(jsonStr) {
      try {
        const data = JSON.parse(jsonStr);
        if (!data.stories || !Array.isArray(data.stories)) return false;

        // Clear existing data and insert new
        await this._multiTx(['stories', 'chapters'], 'readwrite', (tx) => {
          const storyStore = tx.objectStore('stories');
          const chStore = tx.objectStore('chapters');

          // Clear all
          storyStore.clear();
          chStore.clear();

          // Insert stories and chapters
          for (const s of data.stories) {
            const chapters = s.chapters || [];
            const totalWords = chapters.reduce((sum, ch) => sum + countWords(ch.content), 0);

            storyStore.put({
              id: s.id,
              title: s.title,
              author: s.author || '',
              description: s.description || '',
              coverGradient: s.coverGradient ?? 0,
              chapterCount: chapters.length,
              totalWords,
              lastReadChapter: s.lastReadChapter ?? -1,
              lastReadScroll: s.lastReadScroll ?? 0,
              createdAt: s.createdAt || Date.now(),
              updatedAt: s.updatedAt || Date.now(),
            });

            chapters.forEach((ch, i) => {
              chStore.put({
                id: ch.id || generateId(),
                storyId: s.id,
                order: i,
                title: ch.title,
                content: ch.content || '',
                wordCount: countWords(ch.content),
                createdAt: ch.createdAt || Date.now(),
                updatedAt: ch.updatedAt || Date.now(),
              });
            });
          }
        });

        if (data.settings) {
          this.saveSettings(data.settings);
        }
        return true;
      } catch (e) {
        console.error('Import error:', e);
        return false;
      }
    },

    // --- Migration: one-time import from old LocalStorage format ---
    async migrateFromLocalStorage() {
      const OLD_STORAGE_KEY = 'dockl_data';
      try {
        const raw = localStorage.getItem(OLD_STORAGE_KEY);
        if (!raw) return false;

        const data = JSON.parse(raw);
        if (!data.stories || !Array.isArray(data.stories) || data.stories.length === 0) return false;

        // Check if DB is already populated
        const existing = await this.getStories();
        if (existing.length > 0) return false; // Already migrated

        const success = await this.importData(raw);
        if (success) {
          // Remove old localStorage data after successful migration
          localStorage.removeItem(OLD_STORAGE_KEY);
          console.log('DocKL: Migrated data from LocalStorage to IndexedDB successfully.');
          return true;
        }
        return false;
      } catch (e) {
        console.error('Migration error:', e);
        return false;
      }
    },
  };

  // ==================== APP ====================
  const App = {
    currentView: 'library',
    currentStoryId: null,
    currentChapterIndex: 0,
    editingStoryId: null,
    editingChapterId: null,
    readerSettings: null,
    controlsVisible: false,
    settingsVisible: false,
    _touchStartX: 0,
    _touchStartY: 0,
    _autoSaveTimer: null,
    _modalResolve: null,
    // Cache for the current story + chapters (avoids repeated DB reads)
    _cachedStory: null,

    // ==================== INIT ====================
    async init() {
      try {
        await DataStore.open();
        // Auto-migrate from old LocalStorage if needed
        await DataStore.migrateFromLocalStorage();
      } catch (e) {
        console.error('Failed to open database:', e);
        this.toast('Lỗi mở database. Vui lòng thử lại.', 'error');
        return;
      }

      this.readerSettings = DataStore.getSettings();
      this.renderGradientPicker();
      this.bindEvents();
      await this.showView('library');
    },

    // ==================== VIEW MANAGEMENT ====================
    async showView(viewName, params = {}) {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));

      this.currentView = viewName;
      this._cachedStory = null; // Clear cache on view change

      switch (viewName) {
        case 'library':
          await this.renderLibrary();
          break;
        case 'detail':
          this.currentStoryId = params.storyId;
          await this.renderDetail();
          break;
        case 'storyForm':
          this.editingStoryId = params.storyId || null;
          await this.renderStoryForm();
          break;
        case 'chapterForm':
          this.currentStoryId = params.storyId;
          this.editingChapterId = params.chapterId || null;
          await this.renderChapterForm();
          break;
        case 'reader':
          this.currentStoryId = params.storyId;
          this.currentChapterIndex = params.chapterIndex ?? 0;
          await this.renderReader();
          break;
      }
    },

    activateView(id) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('active');
        el.style.animation = 'none';
        el.offsetHeight; // Trigger reflow
        el.style.animation = '';
      }
    },

    // Helper: load story with chapters and cache it
    async _loadStoryWithChapters(storyId) {
      this._cachedStory = await DataStore.getStoryWithChapters(storyId);
      return this._cachedStory;
    },

    // ==================== LIBRARY ====================
    async renderLibrary() {
      this.activateView('library-view');
      const stories = await DataStore.getStories();
      const grid = document.getElementById('story-grid');
      const emptyState = document.getElementById('empty-state');
      const searchInput = document.getElementById('search-input');
      const sortSelect = document.getElementById('sort-select');

      const query = (searchInput.value || '').toLowerCase().trim();
      const sortMode = sortSelect.value;

      let filtered = stories.filter(s => {
        if (!query) return true;
        return s.title.toLowerCase().includes(query) ||
               (s.author || '').toLowerCase().includes(query);
      });

      // Sort
      filtered = [...filtered].sort((a, b) => {
        switch (sortMode) {
          case 'reading':
            const aRead = a.lastReadChapter >= 0 ? 1 : 0;
            const bRead = b.lastReadChapter >= 0 ? 1 : 0;
            if (bRead !== aRead) return bRead - aRead;
            return b.updatedAt - a.updatedAt;
          case 'alpha':
            return a.title.localeCompare(b.title, 'vi');
          case 'newest':
          default:
            return b.createdAt - a.createdAt;
        }
      });

      if (filtered.length === 0) {
        grid.innerHTML = '';
        emptyState.classList.remove('hidden');
        if (query) {
          emptyState.querySelector('h3').textContent = 'Không tìm thấy';
          emptyState.querySelector('p').innerHTML = `Không có truyện nào khớp với "<strong>${escapeHtml(query)}</strong>"`;
        } else {
          emptyState.querySelector('h3').textContent = 'Chưa có truyện nào';
          emptyState.querySelector('p').innerHTML = 'Nhấn nút <strong>+</strong> để thêm truyện đầu tiên';
        }
      } else {
        emptyState.classList.add('hidden');
        grid.innerHTML = filtered.map(s => this.renderStoryCard(s)).join('');
      }
    },

    renderStoryCard(story) {
      const initials = getInitials(story.title);
      const gradient = GRADIENTS[story.coverGradient % GRADIENTS.length];
      const totalChapters = story.chapterCount || 0;
      const readChapters = story.lastReadChapter >= 0 ? story.lastReadChapter + 1 : 0;
      const progress = totalChapters > 0 ? Math.round((readChapters / totalChapters) * 100) : 0;

      return `
        <div class="story-card" data-story-id="${story.id}">
          <div class="story-card-cover" style="background:${gradient}">
            <span class="story-card-initials">${escapeHtml(initials)}</span>
          </div>
          <div class="story-card-body">
            <div class="story-card-title">${escapeHtml(story.title)}</div>
            <div class="story-card-author">${escapeHtml(story.author || 'Ẩn danh')}</div>
            <div class="story-card-meta">
              <span class="story-card-chapters">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
                ${totalChapters}
              </span>
              ${totalChapters > 0 ? `
                <div class="story-card-progress">
                  <div class="story-card-progress-fill" style="width:${progress}%"></div>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    },

    // ==================== DETAIL ====================
    async renderDetail() {
      this.activateView('detail-view');
      const story = await this._loadStoryWithChapters(this.currentStoryId);
      if (!story) {
        await this.showView('library');
        return;
      }

      const gradient = GRADIENTS[story.coverGradient % GRADIENTS.length];
      const initials = getInitials(story.title);
      const totalWords = story.totalWords || story.chapters.reduce((sum, ch) => sum + (ch.wordCount || countWords(ch.content)), 0);
      const readTime = estimateReadingTime(totalWords);

      document.getElementById('detail-cover').style.background = gradient;
      document.getElementById('detail-cover').textContent = initials;
      document.getElementById('detail-title').textContent = story.title;
      document.getElementById('detail-author').textContent = story.author || 'Ẩn danh';
      document.getElementById('detail-desc').textContent = story.description || '';
      document.getElementById('detail-desc').style.display = story.description ? 'block' : 'none';

      document.getElementById('detail-stats').innerHTML = `
        <span class="stat-badge">📚 ${story.chapters.length} chương</span>
        <span class="stat-badge">📝 ${totalWords.toLocaleString()} từ</span>
        ${totalWords > 0 ? `<span class="stat-badge">⏱ ${readTime}</span>` : ''}
      `;

      // Continue reading button
      const btnContinue = document.getElementById('btn-continue-read');
      if (story.chapters.length > 0 && story.lastReadChapter >= 0) {
        btnContinue.classList.remove('hidden');
        const chIdx = Math.min(story.lastReadChapter, story.chapters.length - 1);
        btnContinue.querySelector('span').textContent = `Tiếp tục: ${story.chapters[chIdx].title || `Chương ${chIdx + 1}`}`;
      } else if (story.chapters.length > 0) {
        btnContinue.classList.remove('hidden');
        btnContinue.querySelector('span').textContent = 'Bắt đầu đọc';
      } else {
        btnContinue.classList.add('hidden');
      }

      // Chapter list
      const chaptersContainer = document.getElementById('chapters-container');
      const noChapters = document.getElementById('no-chapters');

      if (story.chapters.length === 0) {
        chaptersContainer.innerHTML = '';
        noChapters.classList.remove('hidden');
      } else {
        noChapters.classList.add('hidden');
        chaptersContainer.innerHTML = story.chapters.map((ch, i) => {
          const words = ch.wordCount || countWords(ch.content);
          const isReading = i === story.lastReadChapter;
          return `
            <div class="chapter-item ${isReading ? 'is-reading' : ''}" data-chapter-index="${i}" data-chapter-id="${ch.id}">
              <div class="chapter-number">${i + 1}</div>
              <div class="chapter-info">
                <div class="chapter-item-title">${escapeHtml(ch.title || `Chương ${i + 1}`)}</div>
                <div class="chapter-item-meta">${words.toLocaleString()} từ · ${formatDate(ch.updatedAt || ch.createdAt)}</div>
              </div>
              <div class="chapter-actions">
                <button class="icon-btn btn-edit-chapter" data-chapter-id="${ch.id}" title="Sửa" aria-label="Sửa chương">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="icon-btn danger btn-delete-chapter" data-chapter-id="${ch.id}" title="Xóa" aria-label="Xóa chương">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
              </div>
            </div>
          `;
        }).join('');
      }
    },

    // ==================== STORY FORM ====================
    async renderStoryForm() {
      this.activateView('story-form-view');
      const titleEl = document.getElementById('story-form-title');
      const inputTitle = document.getElementById('input-story-title');
      const inputAuthor = document.getElementById('input-story-author');
      const inputDesc = document.getElementById('input-story-desc');

      if (this.editingStoryId) {
        const story = await DataStore.getStory(this.editingStoryId);
        if (!story) { await this.showView('library'); return; }
        titleEl.textContent = 'Sửa truyện';
        inputTitle.value = story.title;
        inputAuthor.value = story.author || '';
        inputDesc.value = story.description || '';
        this.selectGradient(story.coverGradient);
      } else {
        titleEl.textContent = 'Thêm truyện';
        inputTitle.value = '';
        inputAuthor.value = '';
        inputDesc.value = '';
        this.selectGradient(Math.floor(Math.random() * GRADIENTS.length));
      }

      setTimeout(() => inputTitle.focus(), 300);
    },

    renderGradientPicker() {
      const picker = document.getElementById('gradient-picker');
      picker.innerHTML = GRADIENTS.map((g, i) =>
        `<div class="gradient-swatch ${i === 0 ? 'selected' : ''}" data-gradient="${i}" style="background:${g}"></div>`
      ).join('');
    },

    selectGradient(index) {
      document.querySelectorAll('.gradient-swatch').forEach(sw => {
        sw.classList.toggle('selected', parseInt(sw.dataset.gradient) === index);
      });
    },

    getSelectedGradient() {
      const sel = document.querySelector('.gradient-swatch.selected');
      return sel ? parseInt(sel.dataset.gradient) : 0;
    },

    async saveStory() {
      const title = document.getElementById('input-story-title').value.trim();
      const author = document.getElementById('input-story-author').value.trim();
      const description = document.getElementById('input-story-desc').value.trim();
      const coverGradient = this.getSelectedGradient();

      if (!title) {
        this.toast('Vui lòng nhập tên truyện', 'error');
        document.getElementById('input-story-title').focus();
        return;
      }

      if (this.editingStoryId) {
        await DataStore.updateStory(this.editingStoryId, { title, author, description, coverGradient });
        this.toast('Đã cập nhật truyện ✓', 'success');
        await this.showView('detail', { storyId: this.editingStoryId });
      } else {
        const story = await DataStore.addStory({ title, author, description, coverGradient });
        this.toast('Đã thêm truyện mới ✓', 'success');
        await this.showView('detail', { storyId: story.id });
      }
    },

    // ==================== CHAPTER FORM ====================
    // Helper: parse "Chương X: ..." prefix from a chapter title
    _parseChapterTitle(fullTitle) {
      const match = (fullTitle || '').match(/^Chương\s+(\d+)\s*[:\-–—]\s*(.*)$/);
      if (match) {
        return { num: parseInt(match[1], 10), title: match[2].trim() };
      }
      return { num: null, title: (fullTitle || '').trim() };
    },

    async renderChapterForm() {
      this.activateView('chapter-form-view');
      const titleEl = document.getElementById('chapter-form-title');
      const inputTitle = document.getElementById('input-chapter-title');
      const inputContent = document.getElementById('input-chapter-content');
      const preview = document.getElementById('chapter-preview');
      const previewBtn = document.getElementById('btn-preview-toggle');
      const prefixEl = document.getElementById('chapter-number-prefix');

      preview.classList.add('hidden');
      inputContent.classList.remove('hidden');
      previewBtn.classList.remove('active');

      if (this.editingChapterId) {
        const ch = await DataStore.getChapter(this.editingChapterId);
        if (!ch) { await this.showView('detail', { storyId: this.currentStoryId }); return; }
        titleEl.textContent = 'Sửa chương';
        // Parse out the chapter number prefix so user only edits the title part
        const parsed = this._parseChapterTitle(ch.title);
        const chapterNum = parsed.num ?? (ch.order + 1);
        prefixEl.textContent = `Chương ${chapterNum}:`;
        inputTitle.value = parsed.title;
        inputContent.value = ch.content || '';
      } else {
        const chapters = await DataStore.getChapters(this.currentStoryId);
        const nextNum = chapters.length + 1;
        titleEl.textContent = 'Thêm chương';
        prefixEl.textContent = `Chương ${nextNum}:`;
        inputTitle.value = '';
        inputContent.value = '';
        inputTitle.placeholder = 'Nhập tiêu đề...';
      }

      this.updateWordCount();
      setTimeout(() => inputTitle.focus(), 300);

      // Start auto-save
      this.startAutoSave();
    },

    updateWordCount() {
      const content = document.getElementById('input-chapter-content').value;
      const words = countWords(content);
      const chars = content.length;
      document.getElementById('word-count').textContent = `${words.toLocaleString()} từ · ${chars.toLocaleString()} ký tự`;
    },

    togglePreview() {
      const editor = document.getElementById('input-chapter-content');
      const preview = document.getElementById('chapter-preview');
      const btn = document.getElementById('btn-preview-toggle');

      if (preview.classList.contains('hidden')) {
        preview.innerHTML = textToHtml(editor.value) || '<p style="color:var(--text-muted);font-style:italic">Chưa có nội dung</p>';
        preview.classList.remove('hidden');
        editor.classList.add('hidden');
        btn.classList.add('active');
        btn.querySelector('span').textContent = 'Soạn thảo';
      } else {
        preview.classList.add('hidden');
        editor.classList.remove('hidden');
        btn.classList.remove('active');
        btn.querySelector('span').textContent = 'Xem trước';
      }
    },

    startAutoSave() {
      this.stopAutoSave();
      this._autoSaveTimer = setInterval(async () => {
        if (this.currentView !== 'chapterForm') { this.stopAutoSave(); return; }
        if (!this.editingChapterId) return;
        const userTitle = document.getElementById('input-chapter-title').value.trim();
        const content = document.getElementById('input-chapter-content').value;
        const prefix = document.getElementById('chapter-number-prefix').textContent.trim();
        if (userTitle || content) {
          const title = userTitle ? `${prefix} ${userTitle}` : '';
          await DataStore.updateChapter(this.currentStoryId, this.editingChapterId, { title, content });
        }
      }, 30000);
    },

    stopAutoSave() {
      if (this._autoSaveTimer) {
        clearInterval(this._autoSaveTimer);
        this._autoSaveTimer = null;
      }
    },

    async saveChapter() {
      const userTitle = document.getElementById('input-chapter-title').value.trim();
      const content = document.getElementById('input-chapter-content').value;
      const prefix = document.getElementById('chapter-number-prefix').textContent.trim();

      if (!userTitle) {
        this.toast('Vui lòng nhập tiêu đề chương', 'error');
        document.getElementById('input-chapter-title').focus();
        return;
      }

      // Combine prefix + user title into full chapter title
      const title = `${prefix} ${userTitle}`;

      this.stopAutoSave();

      if (this.editingChapterId) {
        await DataStore.updateChapter(this.currentStoryId, this.editingChapterId, { title, content });
        this.toast('Đã cập nhật chương ✓', 'success');
      } else {
        await DataStore.addChapter(this.currentStoryId, { title, content });
        this.toast('Đã thêm chương mới ✓', 'success');
      }

      await this.showView('detail', { storyId: this.currentStoryId });
    },

    // ==================== READER ====================
    async renderReader() {
      this.activateView('reader-view');

      const story = await this._loadStoryWithChapters(this.currentStoryId);
      if (!story || story.chapters.length === 0) {
        await this.showView('detail', { storyId: this.currentStoryId });
        this.toast('Truyện chưa có chương nào', 'error');
        return;
      }

      this.currentChapterIndex = Math.min(this.currentChapterIndex, story.chapters.length - 1);
      const chapter = story.chapters[this.currentChapterIndex];

      // Apply settings
      this.applyReaderSettings();

      // Render content
      const contentEl = document.getElementById('reader-content');
      const hasNext = this.currentChapterIndex < story.chapters.length - 1;
      const nextChapter = hasNext ? story.chapters[this.currentChapterIndex + 1] : null;

      contentEl.innerHTML = `
        <div class="reader-text">
          <h2 class="chapter-heading">${escapeHtml(chapter.title || `Chương ${this.currentChapterIndex + 1}`)}</h2>
          ${textToHtml(chapter.content)}
          <div class="reader-chapter-end">
            <div class="end-divider">✦</div>
            ${hasNext ? `
              <p>Chương tiếp theo</p>
              <button class="btn-reader-next-chapter" data-action="next-chapter">
                ${escapeHtml(nextChapter.title || `Chương ${this.currentChapterIndex + 2}`)}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            ` : '<p>— Hết —</p>'}
          </div>
        </div>
      `;

      // Render controls
      document.getElementById('reader-chapter-title').textContent = chapter.title || `Chương ${this.currentChapterIndex + 1}`;
      document.getElementById('reader-chapter-indicator').textContent = `${this.currentChapterIndex + 1} / ${story.chapters.length}`;

      // Chapter selector
      const select = document.getElementById('reader-chapter-select');
      select.innerHTML = story.chapters.map((ch, i) =>
        `<option value="${i}" ${i === this.currentChapterIndex ? 'selected' : ''}>Ch.${i + 1}: ${escapeHtml(ch.title || `Chương ${i + 1}`)}</option>`
      ).join('');

      // Nav button states
      const isFirst = this.currentChapterIndex === 0;
      const isLast = this.currentChapterIndex >= story.chapters.length - 1;
      
      document.getElementById('btn-prev-chapter').disabled = isFirst;
      document.getElementById('btn-next-chapter').disabled = isLast;
      document.getElementById('btn-float-prev').disabled = isFirst;
      document.getElementById('btn-float-next').disabled = isLast;

      // Save reading position
      await DataStore.saveReadPosition(this.currentStoryId, this.currentChapterIndex, 0);

      // Scroll to saved position or top
      const savedScroll = story.lastReadScroll || 0;
      if (this.currentChapterIndex === story.lastReadChapter && savedScroll > 0) {
        setTimeout(() => {
          contentEl.scrollTop = savedScroll * contentEl.scrollHeight;
        }, 100);
      } else {
        contentEl.scrollTop = 0;
      }

      // Hide controls initially
      this.controlsVisible = false;
      this.settingsVisible = false;
      document.getElementById('reader-controls').classList.add('hidden');
      document.getElementById('reader-controls').classList.remove('visible');
      document.getElementById('reader-settings').classList.add('hidden');

      // Reset progress bar
      this.updateReaderProgress();
    },

    applyReaderSettings() {
      const view = document.getElementById('reader-view');
      const content = document.getElementById('reader-content');
      const s = this.readerSettings;

      view.setAttribute('data-theme', s.theme);

      const fontFamily = s.fontFamily === 'serif'
        ? "'Merriweather', 'Noto Serif', Georgia, serif"
        : "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

      content.style.fontSize = `${s.fontSize}px`;
      content.style.fontFamily = fontFamily;
      content.style.lineHeight = `${s.lineHeight}`;

      // Update settings panel UI
      document.getElementById('font-size-value').textContent = s.fontSize;

      document.querySelectorAll('#font-family-toggle .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === s.fontFamily);
      });

      document.querySelectorAll('#theme-toggle .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === s.theme);
      });

      document.querySelectorAll('#line-height-toggle .toggle-btn').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.dataset.lh) === s.lineHeight);
      });
    },

    updateReaderProgress() {
      const content = document.getElementById('reader-content');
      const fill = document.getElementById('reader-progress-fill');
      if (!content || !fill) return;

      const scrollTop = content.scrollTop;
      const scrollHeight = content.scrollHeight - content.clientHeight;
      const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
      fill.style.width = `${Math.min(100, progress)}%`;
    },

    toggleReaderControls() {
      if (this.settingsVisible) {
        this.hideReaderSettings();
        return;
      }

      this.controlsVisible = !this.controlsVisible;
      const controls = document.getElementById('reader-controls');

      if (this.controlsVisible) {
        controls.classList.remove('hidden');
        controls.classList.add('visible');
      } else {
        controls.classList.add('hidden');
        controls.classList.remove('visible');
      }
    },

    toggleReaderSettings() {
      this.settingsVisible = !this.settingsVisible;
      const panel = document.getElementById('reader-settings');

      if (this.settingsVisible) {
        panel.classList.remove('hidden');
      } else {
        panel.classList.add('hidden');
      }
    },

    hideReaderSettings() {
      this.settingsVisible = false;
      document.getElementById('reader-settings').classList.add('hidden');
    },

    async navigateChapter(direction) {
      const story = this._cachedStory;
      if (!story) return;

      const newIndex = this.currentChapterIndex + direction;
      if (newIndex < 0 || newIndex >= story.chapters.length) return;

      this.currentChapterIndex = newIndex;
      await this.renderReader();
    },

    async goToChapter(index) {
      this.currentChapterIndex = index;
      await this.renderReader();
    },

    async exitReader() {
      // Save scroll position
      const content = document.getElementById('reader-content');
      const scrollHeight = content.scrollHeight - content.clientHeight;
      const scrollPct = scrollHeight > 0 ? content.scrollTop / scrollHeight : 0;
      await DataStore.saveReadPosition(this.currentStoryId, this.currentChapterIndex, scrollPct);

      await this.showView('detail', { storyId: this.currentStoryId });
    },

    // ==================== TOAST ====================
    toast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.textContent = message;
      container.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
      }, 2500);
    },

    // ==================== MODAL ====================
    async confirm(title, message) {
      return new Promise((resolve) => {
        this._modalResolve = resolve;
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-message').textContent = message;
        document.getElementById('modal-overlay').classList.remove('hidden');
      });
    },

    closeModal(result) {
      document.getElementById('modal-overlay').classList.add('hidden');
      if (this._modalResolve) {
        this._modalResolve(result);
        this._modalResolve = null;
      }
    },

    // ==================== EXPORT/IMPORT ====================
    async exportData() {
      const json = await DataStore.exportData();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `dockl_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('Đã xuất dữ liệu ✓', 'success');
    },

    async exportStoryAsTxt() {
      const story = this._cachedStory || await DataStore.getStoryWithChapters(this.currentStoryId);
      if (!story) { this.toast('Không tìm thấy truyện', 'error'); return; }

      const SEP = '═'.repeat(48);
      const lines = [];

      // Header
      lines.push(SEP);
      lines.push('DOCKL STORY');
      lines.push(SEP);
      lines.push(`Tiêu đề: ${story.title}`);
      if (story.author) lines.push(`Tác giả: ${story.author}`);
      if (story.description) lines.push(`Mô tả: ${story.description}`);
      lines.push(SEP);
      lines.push('');

      // Chapters
      if (story.chapters && story.chapters.length > 0) {
        story.chapters.forEach((ch, i) => {
          lines.push('');
          lines.push(`${'═'.repeat(4)} ${ch.title || `Chương ${i + 1}`} ${'═'.repeat(4)}`);
          lines.push('');
          lines.push(ch.content || '');
          lines.push('');
        });
      }

      const text = lines.join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Sanitize filename
      const safeName = story.title.replace(/[^\w\s\-à-ỹ]/gi, '').replace(/\s+/g, '_').substring(0, 50) || 'story';
      a.download = `${safeName}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('Đã tải file TXT ✓', 'success');
    },

    _parseTxtFile(text) {
      try {
        const lines = text.split('\n');
        const SEP_FULL = '═'.repeat(48);

        let title = '';
        let author = '';
        let description = '';
        const chapters = [];

        // Find header section
        let headerEnd = -1;
        let headerStart = -1;
        let sepCount = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line === SEP_FULL || line === 'DOCKL STORY') {
            sepCount++;
            if (sepCount === 1) headerStart = i;
            if (sepCount === 3) { headerEnd = i; break; }
            continue;
          }
          if (headerStart >= 0 && headerEnd < 0) {
            if (line.startsWith('Tiêu đề:')) title = line.substring('Tiêu đề:'.length).trim();
            else if (line.startsWith('Tác giả:')) author = line.substring('Tác giả:'.length).trim();
            else if (line.startsWith('Mô tả:')) description = line.substring('Mô tả:'.length).trim();
          }
        }

        if (!title) return null;

        // Find chapters — look for lines matching: ════ Chapter Title ════
        const chapterPattern = /^[═]{2,}\s+(.+?)\s+[═]{2,}$/;
        const chapterPositions = [];

        for (let i = headerEnd + 1; i < lines.length; i++) {
          const match = lines[i].trim().match(chapterPattern);
          if (match) {
            chapterPositions.push({ title: match[1], startLine: i + 1 });
          }
        }

        // Extract chapter contents
        for (let c = 0; c < chapterPositions.length; c++) {
          const start = chapterPositions[c].startLine;
          const end = c < chapterPositions.length - 1 ? chapterPositions[c + 1].startLine - 1 : lines.length;

          // Collect content lines, trim leading/trailing empty lines
          const contentLines = lines.slice(start, end);
          // Find the next chapter separator line and exclude it
          let lastContentLine = contentLines.length;
          for (let j = contentLines.length - 1; j >= 0; j--) {
            if (contentLines[j].trim().match(chapterPattern)) {
              lastContentLine = j;
              break;
            }
          }
          const content = contentLines.slice(0, lastContentLine).join('\n').trim();

          chapters.push({
            title: chapterPositions[c].title,
            content,
          });
        }

        return { title, author, description, chapters };
      } catch (e) {
        console.error('TXT parse error:', e);
        return null;
      }
    },

    importData() {
      document.getElementById('import-file-input').click();
    },

    async handleImportFile(file) {
      if (!file) return;

      const fileName = file.name.toLowerCase();
      const reader = new FileReader();

      reader.onload = async (e) => {
        const content = e.target.result;

        if (fileName.endsWith('.txt')) {
          // Parse TXT and create a new story
          const parsed = this._parseTxtFile(content);
          if (!parsed) {
            this.toast('File TXT không hợp lệ hoặc không đúng định dạng DocKL', 'error');
            return;
          }

          // Create story
          const story = await DataStore.addStory({
            title: parsed.title,
            author: parsed.author,
            description: parsed.description,
            coverGradient: Math.floor(Math.random() * GRADIENTS.length),
          });

          // Add chapters
          for (const ch of parsed.chapters) {
            await DataStore.addChapter(story.id, {
              title: ch.title,
              content: ch.content,
            });
          }

          this.toast(`Đã nhập "${parsed.title}" (${parsed.chapters.length} chương) ✓`, 'success');
          await this.showView('detail', { storyId: story.id });

        } else {
          // JSON import (existing logic)
          const success = await DataStore.importData(content);
          if (success) {
            this.toast('Đã nhập dữ liệu thành công ✓', 'success');
            await this.showView('library');
          } else {
            this.toast('File không hợp lệ', 'error');
          }
        }
      };
      reader.readAsText(file);
    },

    // ==================== EVENT BINDING ====================
    bindEvents() {
      // --- Library ---
      document.getElementById('story-grid').addEventListener('click', (e) => {
        const card = e.target.closest('.story-card');
        if (card) this.showView('detail', { storyId: card.dataset.storyId });
      });

      document.getElementById('fab-add').addEventListener('click', () => {
        this.showView('storyForm', {});
      });

      document.getElementById('search-input').addEventListener('input', debounce(() => {
        this.renderLibrary();
      }, 200));

      document.getElementById('sort-select').addEventListener('change', () => {
        this.renderLibrary();
      });

      document.getElementById('btn-export').addEventListener('click', () => this.exportData());
      document.getElementById('btn-import').addEventListener('click', () => this.importData());
      document.getElementById('import-file-input').addEventListener('change', (e) => {
        this.handleImportFile(e.target.files[0]);
        e.target.value = '';
      });

      // --- Detail ---
      document.getElementById('btn-download-txt').addEventListener('click', () => this.exportStoryAsTxt());
      const btnDownloadFull = document.getElementById('btn-download-txt-full');
      if (btnDownloadFull) btnDownloadFull.addEventListener('click', () => this.exportStoryAsTxt());

      document.getElementById('btn-edit-story').addEventListener('click', () => {
        this.showView('storyForm', { storyId: this.currentStoryId });
      });

      document.getElementById('btn-delete-story').addEventListener('click', async () => {
        const story = await DataStore.getStory(this.currentStoryId);
        if (!story) return;
        const ok = await this.confirm('Xóa truyện', `Bạn có chắc muốn xóa "${story.title}"? Tất cả các chương sẽ bị xóa vĩnh viễn.`);
        if (ok) {
          await DataStore.deleteStory(this.currentStoryId);
          this.toast('Đã xóa truyện', 'success');
          await this.showView('library');
        }
      });

      document.getElementById('btn-continue-read').addEventListener('click', async () => {
        const story = this._cachedStory || await DataStore.getStoryWithChapters(this.currentStoryId);
        if (!story || story.chapters.length === 0) return;
        const chIdx = story.lastReadChapter >= 0 ? Math.min(story.lastReadChapter, story.chapters.length - 1) : 0;
        await this.showView('reader', { storyId: this.currentStoryId, chapterIndex: chIdx });
      });

      document.getElementById('btn-add-chapter').addEventListener('click', () => {
        this.showView('chapterForm', { storyId: this.currentStoryId });
      });

      // Chapter list events (delegation)
      document.getElementById('chapters-container').addEventListener('click', (e) => {
        const editBtn = e.target.closest('.btn-edit-chapter');
        const deleteBtn = e.target.closest('.btn-delete-chapter');
        const chapterItem = e.target.closest('.chapter-item');

        if (editBtn) {
          e.stopPropagation();
          this.showView('chapterForm', { storyId: this.currentStoryId, chapterId: editBtn.dataset.chapterId });
        } else if (deleteBtn) {
          e.stopPropagation();
          const chId = deleteBtn.dataset.chapterId;
          this.confirm('Xóa chương', 'Bạn có chắc muốn xóa chương này?').then(async (ok) => {
            if (ok) {
              await DataStore.deleteChapter(this.currentStoryId, chId);
              this.toast('Đã xóa chương', 'success');
              await this.renderDetail();
            }
          });
        } else if (chapterItem) {
          const idx = parseInt(chapterItem.dataset.chapterIndex);
          this.showView('reader', { storyId: this.currentStoryId, chapterIndex: idx });
        }
      });

      // --- Back buttons ---
      document.querySelectorAll('.btn-back').forEach(btn => {
        btn.addEventListener('click', () => {
          const nav = btn.dataset.navigate;
          if (nav === 'library') {
            this.showView('library');
          } else {
            // Smart back navigation
            if (this.currentView === 'storyForm') {
              if (this.editingStoryId) {
                this.showView('detail', { storyId: this.editingStoryId });
              } else {
                this.showView('library');
              }
            } else if (this.currentView === 'chapterForm') {
              this.stopAutoSave();
              this.showView('detail', { storyId: this.currentStoryId });
            }
          }
        });
      });

      // --- Story Form ---
      document.getElementById('btn-save-story').addEventListener('click', () => this.saveStory());

      document.getElementById('gradient-picker').addEventListener('click', (e) => {
        const swatch = e.target.closest('.gradient-swatch');
        if (swatch) this.selectGradient(parseInt(swatch.dataset.gradient));
      });

      // --- Chapter Form ---
      document.getElementById('btn-save-chapter').addEventListener('click', () => this.saveChapter());

      document.getElementById('input-chapter-content').addEventListener('input', debounce(() => {
        this.updateWordCount();
      }, 150));

      document.getElementById('btn-preview-toggle').addEventListener('click', () => this.togglePreview());

      // --- Reader ---
      const readerContent = document.getElementById('reader-content');

      // Tap to toggle controls
      readerContent.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a') || e.target.closest('select')) return;

        const nextBtn = e.target.closest('[data-action="next-chapter"]');
        if (nextBtn) {
          this.navigateChapter(1);
          return;
        }

        this.toggleReaderControls();
      });

      // Scroll progress
      readerContent.addEventListener('scroll', debounce(() => {
        this.updateReaderProgress();

        // Save position periodically
        if (this.currentView === 'reader') {
          const scrollHeight = readerContent.scrollHeight - readerContent.clientHeight;
          const scrollPct = scrollHeight > 0 ? readerContent.scrollTop / scrollHeight : 0;
          DataStore.saveReadPosition(this.currentStoryId, this.currentChapterIndex, scrollPct);
        }
      }, 100), { passive: true });

      document.getElementById('btn-exit-reader').addEventListener('click', () => this.exitReader());

      document.getElementById('btn-reader-settings').addEventListener('click', () => this.toggleReaderSettings());

      document.getElementById('btn-prev-chapter').addEventListener('click', () => this.navigateChapter(-1));
      document.getElementById('btn-next-chapter').addEventListener('click', () => this.navigateChapter(1));
      
      const btnFloatPrev = document.getElementById('btn-float-prev');
      if (btnFloatPrev) btnFloatPrev.addEventListener('click', () => this.navigateChapter(-1));
      
      const btnFloatNext = document.getElementById('btn-float-next');
      if (btnFloatNext) btnFloatNext.addEventListener('click', () => this.navigateChapter(1));

      document.getElementById('reader-chapter-select').addEventListener('change', (e) => {
        this.goToChapter(parseInt(e.target.value));
      });

      // Font size
      document.getElementById('btn-font-decrease').addEventListener('click', () => {
        if (this.readerSettings.fontSize > 12) {
          this.readerSettings.fontSize -= 2;
          this.applyReaderSettings();
          DataStore.saveSettings(this.readerSettings);
        }
      });

      document.getElementById('btn-font-increase').addEventListener('click', () => {
        if (this.readerSettings.fontSize < 32) {
          this.readerSettings.fontSize += 2;
          this.applyReaderSettings();
          DataStore.saveSettings(this.readerSettings);
        }
      });

      // Font family
      document.getElementById('font-family-toggle').addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (btn && btn.dataset.font) {
          this.readerSettings.fontFamily = btn.dataset.font;
          this.applyReaderSettings();
          DataStore.saveSettings(this.readerSettings);
        }
      });

      // Theme
      document.getElementById('theme-toggle').addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (btn && btn.dataset.theme) {
          this.readerSettings.theme = btn.dataset.theme;
          this.applyReaderSettings();
          DataStore.saveSettings(this.readerSettings);
        }
      });

      // Line height
      document.getElementById('line-height-toggle').addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (btn && btn.dataset.lh) {
          this.readerSettings.lineHeight = parseFloat(btn.dataset.lh);
          this.applyReaderSettings();
          DataStore.saveSettings(this.readerSettings);
        }
      });

      // --- Swipe gestures for reader ---
      readerContent.addEventListener('touchstart', (e) => {
        this._touchStartX = e.touches[0].clientX;
        this._touchStartY = e.touches[0].clientY;
      }, { passive: true });

      readerContent.addEventListener('touchend', (e) => {
        if (this.currentView !== 'reader') return;
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - this._touchStartX;
        const diffY = endY - this._touchStartY;

        if (Math.abs(diffX) > 80 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
          if (diffX > 0) {
            this.navigateChapter(-1);
          } else {
            this.navigateChapter(1);
          }
        }
      }, { passive: true });

      // --- Keyboard shortcuts ---
      document.addEventListener('keydown', (e) => {
        if (this.currentView !== 'reader') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            this.navigateChapter(-1);
            break;
          case 'ArrowRight':
            e.preventDefault();
            this.navigateChapter(1);
            break;
          case 'Escape':
            e.preventDefault();
            if (this.settingsVisible) {
              this.hideReaderSettings();
            } else {
              this.exitReader();
            }
            break;
          case '+':
          case '=':
            e.preventDefault();
            document.getElementById('btn-font-increase').click();
            break;
          case '-':
            e.preventDefault();
            document.getElementById('btn-font-decrease').click();
            break;
        }
      });

      // --- Modal ---
      document.getElementById('btn-modal-cancel').addEventListener('click', () => this.closeModal(false));
      document.getElementById('btn-modal-confirm').addEventListener('click', () => this.closeModal(true));
      document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) this.closeModal(false);
      });

      // --- Handle browser back button ---
      window.addEventListener('popstate', () => {
        if (this.currentView === 'reader') {
          this.exitReader();
        } else if (this.currentView !== 'library') {
          this.showView('library');
        }
      });
    },
  };

  // ==================== BOOTSTRAP ====================
  document.addEventListener('DOMContentLoaded', () => {
    App.init();
  });

})();
