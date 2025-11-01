/**
 * Flutter Reader Integration Layer
 * This script provides a bridge between Flutter InAppWebView and the Readest reader
 */

window.FlutterReaderAPI = {
  // Store for book data and settings
  bookCache: new Map(),
  currentBook: null,

  // Initialize reader with file path
  async openBookFromPath(filePath, options = {}) {
    try {
      console.log('Opening book from path:', filePath);

      // For Flutter InAppWebView, we need to handle file loading differently
      let file;
      let fileName = filePath.split('/').pop() || 'unknown';

      // Try different methods to load the file
      if (window.flutter_inappwebview) {
        // Use Flutter bridge to read file
        try {
          const fileData = await window.flutter_inappwebview.callHandler('readBookFile', filePath);
          if (fileData && fileData.content) {
            const bytes = new Uint8Array(fileData.content);
            file = new Blob([bytes], { type: this.getMimeType(fileName) });
          }
        } catch (error) {
          console.log('Flutter bridge file read failed, trying fetch method');
        }
      }

      // Fallback to fetch method
      if (!file) {
        try {
          const response = await fetch(`file://${filePath}`);
          if (response.ok) {
            file = await response.blob();
          }
        } catch (error) {
          console.log('Fetch method failed, trying direct file input');
        }
      }

      if (!file) {
        throw new Error('Unable to load file from any method');
      }

      const bookFile = new File([file], fileName, { type: this.getMimeType(fileName) });

      // Generate unique book ID
      const bookId = await this.generateBookId(bookFile);

      // Create book object
      const book = {
        hash: bookId,
        title: fileName.replace(/\.[^/.]+$/, ''),
        sourceTitle: fileName.replace(/\.[^/.]+$/, ''),
        format: this.getFileFormat(fileName),
        filePath: filePath,
        file: bookFile,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        progress: [1, 1],
        primaryLanguage: 'en',
        author: 'Unknown',
        ...options
      };

      // Cache the book
      this.bookCache.set(bookId, book);
      this.currentBook = book;

      // Initialize reader
      await this.initializeReader(bookId);

      return { success: true, bookId };
    } catch (error) {
      console.error('Error opening book:', error);
      return { success: false, error: error.message };
    }
  },

  // Generate unique book ID from file content
  async generateBookId(file) {
    try {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer.slice(0, 1024));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    } catch (error) {
      // Fallback to simple hash based on filename and size
      const text = file.name + file.size + Date.now();
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return Math.abs(hash).toString(16).padStart(16, '0');
    }
  },

  // Get MIME type from extension
  getMimeType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeTypes = {
      epub: 'application/epub+zip',
      pdf: 'application/pdf',
      mobi: 'application/x-mobipocket-ebook',
      azw3: 'application/vnd.amazon.ebook',
      fb2: 'application/x-fictionbook+xml',
      txt: 'text/plain'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  },

  // Get file format from extension
  getFileFormat(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const formats = {
      epub: 'epub',
      pdf: 'pdf',
      mobi: 'mobi',
      azw3: 'azw3',
      fb2: 'fb2',
      txt: 'txt'
    };
    return formats[ext] || 'unknown';
  },

  // Initialize the reader with book
  async initializeReader(bookId) {
    const book = this.bookCache.get(bookId);
    if (!book) {
      throw new Error('Book not found in cache');
    }

    // Wait for Next.js to initialize
    if (typeof window !== 'undefined') {
      let attempts = 0;
      while (typeof window.__NEXT_LOADED_PAGES__ === 'undefined' && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
    }

    // Inject book data into the page
    window.__FLUTTER_BOOK_DATA__ = {
      book,
      bookId,
      isFlutterMode: true
    };

    // Update URL params to match expected format
    if (window.history && window.location) {
      const url = new URL(window.location);
      url.searchParams.set('ids', bookId);
      window.history.replaceState({}, '', url);
    }

    // Trigger reader initialization
    this.notifyReaderReady();
  },

  // Notify that reader is ready
  notifyReaderReady() {
    const event = new CustomEvent('flutter-reader-ready', {
      detail: {
        bookId: this.currentBook?.hash,
        book: this.currentBook
      }
    });
    window.dispatchEvent(event);
  },

  // Get current reading progress
  getProgress() {
    return this.currentBook?.progress || [1, 1];
  },

  // Set reading progress
  setProgress(progress) {
    if (this.currentBook) {
      this.currentBook.progress = progress;
      this.notifyProgressUpdate(progress);
    }
  },

  // Notify Flutter about progress updates
  notifyProgressUpdate(progress) {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onProgressUpdate', {
        progress,
        bookId: this.currentBook?.hash
      }).catch(error => {
        console.log('Failed to notify Flutter about progress:', error);
      });
    }
  },

  // Save book configuration
  saveBookConfig(config) {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('saveBookConfig', {
        bookId: this.currentBook?.hash,
        config,
        progress: config.progress
      }).catch(error => {
        console.log('Failed to save book config to Flutter:', error);
      });
    }
  },

  // Close current book
  closeBook() {
    this.currentBook = null;
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler('onBookClosed').catch(error => {
        console.log('Failed to notify Flutter about book close:', error);
      });
    }
  }
};

// Handle URL routing for Flutter integration
(function() {
  if (typeof window === 'undefined') return;

  const path = window.location.pathname;
  const match = path.match(/^\/read\/(.+)$/);

  if (match) {
    const filePath = decodeURIComponent(match[1]);

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        window.FlutterReaderAPI.openBookFromPath(filePath);
      });
    } else {
      window.FlutterReaderAPI.openBookFromPath(filePath);
    }
  }
})();

// Override the default book loading for Flutter mode
window.__FLUTTER_OVERRIDE__ = {
  loadBookContent: async function(book, settings) {
    if (window.__FLUTTER_BOOK_DATA__ && window.__FLUTTER_BOOK_DATA__.book) {
      const flutterBook = window.__FLUTTER_BOOK_DATA__.book;
      return {
        book: flutterBook,
        file: flutterBook.file,
        config: {
          updatedAt: Date.now(),
          progress: flutterBook.progress,
          location: '',
          viewSettings: {},
          booknotes: []
        }
      };
    }
    return null;
  },

  saveBookConfig: async function(book, config, settings) {
    // Save to Flutter storage via bridge
    if (window.FlutterReaderAPI) {
      window.FlutterReaderAPI.saveBookConfig(config);
    }
    return true;
  }
};