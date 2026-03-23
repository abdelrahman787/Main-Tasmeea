import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ==========================================
// API: Fetch Quran page data from quran.com
// ==========================================
app.get('/api/quran/page/:pageNumber', async (c) => {
  const pageNumber = parseInt(c.req.param('pageNumber'))
  if (isNaN(pageNumber) || pageNumber < 1 || pageNumber > 604) {
    return c.json({ error: 'Invalid page number (1-604)' }, 400)
  }

  try {
    const url = `https://api.quran.com/api/v4/verses/by_page/${pageNumber}?words=true&fields=text_uthmani&per_page=50&word_fields=text_uthmani,text_imlaei,text_qpc_hafs,line_number,page_number,location,code_v2,v2_page`
    const response = await fetch(url)
    const data = await response.json() as any

    // Process and structure the data for our app
    const words: any[] = []
    const verses: any[] = []

    for (const verse of data.verses) {
      const verseWords: any[] = []
      for (const word of verse.words) {
        if (word.char_type_name === 'word') {
          const wordData = {
            id: word.id,
            position: word.position,
            text_uthmani: word.text_uthmani,
            text_imlaei: word.text_imlaei,
            text_qpc_hafs: word.text_qpc_hafs,
            line_number: word.line_number,
            page_number: word.page_number,
            location: word.location,
            verse_key: verse.verse_key,
            audio_url: word.audio_url ? `https://audio.qurancdn.com/${word.audio_url}` : null,
            code_v2: word.code_v2,
            v2_page: word.v2_page,
          }
          words.push(wordData)
          verseWords.push(wordData)
        }
      }

      verses.push({
        verse_key: verse.verse_key,
        verse_number: verse.verse_number,
        chapter_id: verse.chapter_id,
        text_uthmani: verse.text_uthmani,
        page_number: verse.page_number,
        words: verseWords,
        // Include end markers for display
        all_tokens: verse.words.map((w: any) => ({
          id: w.id,
          position: w.position,
          text_uthmani: w.text_uthmani,
          text_qpc_hafs: w.text_qpc_hafs,
          line_number: w.line_number,
          char_type_name: w.char_type_name,
          location: w.location,
          code_v2: w.code_v2,
          v2_page: w.v2_page,
        }))
      })
    }

    return c.json({
      page_number: pageNumber,
      verses,
      words,
      total_words: words.length,
      pagination: data.pagination
    })
  } catch (err: any) {
    return c.json({ error: 'Failed to fetch Quran data', details: err.message }, 500)
  }
})

// ==========================================
// API: Fetch Surah list
// ==========================================
app.get('/api/quran/surahs', async (c) => {
  try {
    const response = await fetch('https://api.quran.com/api/v4/chapters?language=ar')
    const data = await response.json() as any
    return c.json(data)
  } catch (err: any) {
    return c.json({ error: 'Failed to fetch surahs' }, 500)
  }
})

// ==========================================
// API: Fetch Surah info
// ==========================================
app.get('/api/quran/surah/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const response = await fetch(`https://api.quran.com/api/v4/chapters/${id}?language=ar`)
    const data = await response.json() as any
    return c.json(data)
  } catch (err: any) {
    return c.json({ error: 'Failed to fetch surah info' }, 500)
  }
})

// ==========================================
// D1 Database API routes (for session persistence)
// ==========================================

// Save session
app.post('/api/sessions', async (c) => {
  try {
    const body = await c.req.json()
    const db = c.env?.DB
    
    // If no DB, store in-memory (will be lost on restart)
    if (!db) {
      return c.json({ success: true, id: Date.now().toString(), note: 'No D1 database configured, data stored client-side only' })
    }

    const result = await db.prepare(`
      INSERT INTO sessions (id, user_id, start_time, end_time, mode, difficulty, scope_type, scope_value, total_words, correct_words, errors_count, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.id,
      body.user_id || 'anonymous',
      body.start_time,
      body.end_time,
      body.mode,
      body.difficulty,
      body.scope_type,
      body.scope_value,
      body.total_words,
      body.correct_words,
      body.errors_count,
      body.duration_seconds
    ).run()

    return c.json({ success: true, id: body.id })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Save error logs
app.post('/api/sessions/:sessionId/errors', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const body = await c.req.json()
    const db = c.env?.DB

    if (!db) {
      return c.json({ success: true, note: 'No D1 database configured' })
    }

    for (const error of body.errors) {
      await db.prepare(`
        INSERT INTO error_logs (session_id, word_location, expected_text, recognized_text, error_type, attempts, page_number, line_number)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        sessionId,
        error.word_location,
        error.expected_text,
        error.recognized_text || '',
        error.error_type,
        error.attempts,
        error.page_number,
        error.line_number
      ).run()
    }

    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Get session history
app.get('/api/sessions', async (c) => {
  try {
    const db = c.env?.DB
    if (!db) {
      return c.json({ sessions: [], note: 'No D1 database configured, using client-side storage' })
    }

    const userId = c.req.query('user_id') || 'anonymous'
    const result = await db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY start_time DESC LIMIT 50
    `).bind(userId).all()

    return c.json({ sessions: result.results })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Get session details with errors
app.get('/api/sessions/:sessionId', async (c) => {
  try {
    const sessionId = c.req.param('sessionId')
    const db = c.env?.DB
    if (!db) {
      return c.json({ session: null, errors: [], note: 'No D1 database configured' })
    }

    const session = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(sessionId).first()
    const errors = await db.prepare('SELECT * FROM error_logs WHERE session_id = ?').bind(sessionId).all()

    return c.json({ session, errors: errors.results })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ==========================================
// Main HTML page
// ==========================================
app.get('/*', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Quran Tasmee3 - تسميع القرآن</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400;1,700&family=Amiri+Quran&family=Noto+Naskh+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
    <style>
      /* UthmanicHafs font for verse-end markers and fallback */
      @font-face {
        font-family: 'UthmanicHafs';
        src: url('https://verses.quran.foundation/fonts/quran/hafs/uthmanic_hafs/UthmanicHafs1Ver18.woff2') format('woff2');
        font-display: swap;
      }
    </style>
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          extend: {
            fontFamily: {
              quran: ['"Amiri Quran"', '"Amiri"', '"Noto Naskh Arabic"', 'serif'],
              arabic: ['"Noto Naskh Arabic"', '"Amiri"', 'serif'],
            },
            colors: {
              quran: {
                gold: '#c5a028',
                border: '#8b7d3c',
                bg: '#fef9e7',
                dark: '#1a1a2e',
                darkBg: '#16213e',
                darkCard: '#1a1a2e',
              }
            }
          }
        }
      }
    </script>
    <style>
      @keyframes fadeInWord {
        from { opacity: 0; transform: scale(0.8); }
        to { opacity: 1; transform: scale(1); }
      }
      @keyframes pulseListening {
        0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
        50% { box-shadow: 0 0 0 15px rgba(239, 68, 68, 0); }
      }
      @keyframes breathe {
        0%, 100% { transform: scale(1); opacity: 0.7; }
        50% { transform: scale(1.15); opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes shimmer {
        0% { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      .word-revealed {
        animation: fadeInWord 0.4s ease-out forwards;
      }
      .word-hidden {
        color: transparent !important;
        text-shadow: none;
        background: linear-gradient(90deg, transparent 33%, rgba(0,0,0,0.05) 50%, transparent 66%);
        background-size: 200% 100%;
        animation: shimmer 2s infinite;
        border-radius: 4px;
        user-select: none;
      }
      .dark .word-hidden {
        background: linear-gradient(90deg, transparent 33%, rgba(255,255,255,0.05) 50%, transparent 66%);
        background-size: 200% 100%;
      }
      .listening-indicator {
        animation: pulseListening 1.5s infinite;
      }
      .breathe {
        animation: breathe 2s ease-in-out infinite;
      }
      .slide-up {
        animation: slideUp 0.3s ease-out;
      }
      .quran-page {
        background: linear-gradient(180deg, #fdf8e8 0%, #faf3d6 30%, #f8eed0 50%, #faf3d6 70%, #fdf8e8 100%);
        border: 3px solid #b8962a;
        box-shadow: 0 4px 24px rgba(0,0,0,0.12), inset 0 0 80px rgba(197,160,40,0.06);
        position: relative;
        overflow: hidden;
      }
      .quran-page::before {
        content: '';
        position: absolute;
        top: 4px; right: 4px; bottom: 4px; left: 4px;
        border: 1px solid rgba(184,150,42,0.4);
        pointer-events: none;
        border-radius: 8px;
      }
      .dark .quran-page {
        background: linear-gradient(180deg, #1e1e32 0%, #1a1a2e 30%, #161628 50%, #1a1a2e 70%, #1e1e32 100%);
        border-color: #9e8530;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5), inset 0 0 80px rgba(197,160,40,0.02);
      }
      .dark .quran-page::before {
        border-color: rgba(158,133,48,0.3);
      }
      .quran-line {
        min-height: 52px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        direction: rtl;
        padding: 0 4px;
        border-bottom: 1px solid rgba(184,150,42,0.08);
      }
      .quran-line:last-child {
        border-bottom: none;
      }
      .dark .quran-line {
        border-bottom-color: rgba(184,150,42,0.05);
      }
      .word-cell {
        cursor: default;
        padding: 2px 1px;
        border-radius: 4px;
        transition: all 0.3s ease;
        display: inline-block;
      }
      .word-cell.current-word {
        background: rgba(197,160,40,0.18);
        border-bottom: 2px solid #c5a028;
      }
      .dark .word-cell.current-word {
        background: rgba(197,160,40,0.12);
      }
      .word-cell.error-flash {
        background: rgba(239, 68, 68, 0.15);
      }
      .ayah-marker {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-family: 'UthmanicHafs', serif;
        color: #8b7d3c;
        position: relative;
      }
      .dark .ayah-marker {
        color: #b8962a;
      }
      /* QCF font word styling */
      .qcf-word {
        display: inline-block;
        line-height: 1;
      }
      .qcf-word.loading {
        font-family: 'UthmanicHafs', 'Amiri Quran', serif;
        opacity: 0.7;
      }
      .dark .qcf-word {
        color: #d4c89a !important;
      }
      .dark .qcf-word.word-hidden {
        color: transparent !important;
      }
      /* Surah header within Mushaf page */
      .mushaf-surah-header {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 6px 16px;
        margin: 4px 0 8px;
        background: linear-gradient(90deg, transparent 0%, rgba(184,150,42,0.12) 20%, rgba(184,150,42,0.2) 50%, rgba(184,150,42,0.12) 80%, transparent 100%);
        border-top: 2px solid rgba(184,150,42,0.35);
        border-bottom: 2px solid rgba(184,150,42,0.35);
        position: relative;
      }
      .mushaf-surah-header::before,
      .mushaf-surah-header::after {
        content: '❊';
        color: #b8962a;
        font-size: 14px;
      }
      .dark .mushaf-surah-header {
        background: linear-gradient(90deg, transparent 0%, rgba(184,150,42,0.08) 20%, rgba(184,150,42,0.12) 50%, rgba(184,150,42,0.08) 80%, transparent 100%);
        border-top-color: rgba(158,133,48,0.3);
        border-bottom-color: rgba(158,133,48,0.3);
      }
      .mushaf-bismillah {
        text-align: center;
        padding: 2px 0 6px;
        font-family: 'UthmanicHafs', 'Amiri Quran', serif;
        font-size: 22px;
        color: #3d3520;
      }
      .dark .mushaf-bismillah {
        color: #d4c89a;
      }
      /* Page footer */
      .mushaf-page-footer {
        text-align: center;
        padding-top: 6px;
        border-top: 1px solid rgba(184,150,42,0.2);
        margin-top: 4px;
      }
      /* Scrollbar styling */
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #c5a028; border-radius: 3px; }
      .dark ::-webkit-scrollbar-thumb { background: #8b7d3c; }

      /* Page navigation */
      .page-nav-btn {
        transition: all 0.2s;
      }
      .page-nav-btn:hover {
        transform: scale(1.1);
      }

      /* Surah header decoration (outside mushaf) */
      .surah-header {
        background: linear-gradient(90deg, transparent 0%, rgba(197,160,40,0.1) 30%, rgba(197,160,40,0.2) 50%, rgba(197,160,40,0.1) 70%, transparent 100%);
        border-top: 1px solid rgba(197,160,40,0.3);
        border-bottom: 1px solid rgba(197,160,40,0.3);
      }

      /* Toast notifications */
      .toast {
        animation: slideUp 0.3s ease-out;
      }

      /* Onboarding overlay */
      .onboarding-overlay {
        backdrop-filter: blur(8px);
      }

      /* Stats card */
      .stats-card {
        transition: transform 0.2s;
      }
      .stats-card:hover {
        transform: translateY(-2px);
      }

      /* Mobile adjustments */
      @media (max-width: 640px) {
        .quran-line {
          min-height: 42px;
        }
        .qcf-word {
          font-size: 24px !important;
        }
      }
    </style>
</head>
<body class="bg-gray-50 dark:bg-gray-900 transition-colors duration-300">
    <div id="app"></div>
    <script>
    // ==========================================
    // QURAN TASMEE3 - Complete Application
    // ==========================================

    const App = (() => {
      // ==========================================
      // STATE MANAGEMENT
      // ==========================================
      const state = {
        // App state
        currentView: 'home', // home, mushaf, session, analytics, settings, session-detail
        darkMode: localStorage.getItem('darkMode') === 'true',
        showOnboarding: !localStorage.getItem('onboardingDone'),
        
        // Quran data
        currentPage: parseInt(localStorage.getItem('lastPage')) || 1,
        pageData: null,
        surahs: null,
        loading: false,
        
        // Session state
        sessionActive: false,
        sessionPaused: false,
        sessionStartTime: null,
        currentWordIndex: 0,
        revealedWords: new Set(),
        wordAttempts: {},
        errorLogs: [],
        sessionStats: {
          totalWords: 0,
          correctWords: 0,
          errors: 0,
        },
        
        // Speech recognition
        recognition: null,
        isListening: false,
        lastSpeechTime: null,
        silenceTimer: null,
        asrFailCount: 0,
        _isRestarting: false,
        _lastInterim: '',
        _pendingRender: null,
        _restartAttempts: 0,
        _maxRestartAttempts: 50,
        _keepAliveTimer: null,
        
        // Debug log for speech-matching analysis
        debugLog: [],
        showDebugPanel: localStorage.getItem('showDebugPanel') === 'true',
        
        // Settings
        difficulty: localStorage.getItem('difficulty') || 'normal',
        
        // Matching thresholds
        thresholds: {
          easy: { levenshtein: 0.30, confidence: 0.60 },
          normal: { levenshtein: 0.20, confidence: 0.75 },
          strict: { levenshtein: 0.10, confidence: 0.85 },
        },
        
        // Session history (client-side)
        sessionHistory: JSON.parse(localStorage.getItem('sessionHistory') || '[]'),
        
        // Selected session for detail view
        selectedSession: null,
        
        // Toast messages
        toasts: [],
      }

      // ==========================================
      // QCF V2 FONT LOADING (Madinah Mushaf)
      // ==========================================
      const QCFFontLoader = {
        loadedFonts: new Set(),
        loadingFonts: new Map(), // page -> Promise
        CDN_BASE: 'https://verses.quran.foundation',

        async loadPageFont(pageNumber) {
          const fontName = 'p' + pageNumber + '-v2'
          if (this.loadedFonts.has(fontName)) return fontName

          // If already loading, wait for it
          if (this.loadingFonts.has(pageNumber)) {
            return this.loadingFonts.get(pageNumber)
          }

          const promise = (async () => {
            try {
              const fontFace = new FontFace(
                fontName,
                "url('" + this.CDN_BASE + "/fonts/quran/hafs/v2/woff2/p" + pageNumber + ".woff2')"
              )
              fontFace.display = 'block'
              await fontFace.load()
              document.fonts.add(fontFace)
              this.loadedFonts.add(fontName)
              // Inject CSS class for this page font
              this.injectFontCSS(pageNumber, fontName)
              return fontName
            } catch (error) {
              console.error('Failed to load QCF font for page ' + pageNumber + ':', error)
              return null
            } finally {
              this.loadingFonts.delete(pageNumber)
            }
          })()

          this.loadingFonts.set(pageNumber, promise)
          return promise
        },
        
        // Inject a CSS class for the font so we don't need inline styles
        injectFontCSS(pageNumber, fontName) {
          const styleId = 'qcf-style-p' + pageNumber
          if (document.getElementById(styleId)) return
          const style = document.createElement('style')
          style.id = styleId
          style.textContent = '.qcf-p' + pageNumber + ' { font-family: "' + fontName + '", serif; color: #2c2416; }'
          style.textContent += ' .dark .qcf-p' + pageNumber + ' { color: #d4c89a; }'
          style.textContent += ' .dark .qcf-p' + pageNumber + '.word-hidden { color: transparent; }'
          document.head.appendChild(style)
        },

        async loadPageFonts(pageNumbers) {
          const unique = [...new Set(pageNumbers)]
          await Promise.all(unique.map(p => this.loadPageFont(p)))
        },

        isFontLoaded(pageNumber) {
          return this.loadedFonts.has('p' + pageNumber + '-v2')
        },

        getFontFamily(pageNumber) {
          return 'p' + pageNumber + '-v2'
        }
      }

      // Surah names lookup (Arabic)
      const SURAH_NAMES = {
        1: 'الفاتحة', 2: 'البقرة', 3: 'آل عمران', 4: 'النساء', 5: 'المائدة',
        6: 'الأنعام', 7: 'الأعراف', 8: 'الأنفال', 9: 'التوبة', 10: 'يونس',
        11: 'هود', 12: 'يوسف', 13: 'الرعد', 14: 'إبراهيم', 15: 'الحجر',
        16: 'النحل', 17: 'الإسراء', 18: 'الكهف', 19: 'مريم', 20: 'طه',
        21: 'الأنبياء', 22: 'الحج', 23: 'المؤمنون', 24: 'النور', 25: 'الفرقان',
        26: 'الشعراء', 27: 'النمل', 28: 'القصص', 29: 'العنكبوت', 30: 'الروم',
        31: 'لقمان', 32: 'السجدة', 33: 'الأحزاب', 34: 'سبأ', 35: 'فاطر',
        36: 'يس', 37: 'الصافات', 38: 'ص', 39: 'الزمر', 40: 'غافر',
        41: 'فصلت', 42: 'الشورى', 43: 'الزخرف', 44: 'الدخان', 45: 'الجاثية',
        46: 'الأحقاف', 47: 'محمد', 48: 'الفتح', 49: 'الحجرات', 50: 'ق',
        51: 'الذاريات', 52: 'الطور', 53: 'النجم', 54: 'القمر', 55: 'الرحمن',
        56: 'الواقعة', 57: 'الحديد', 58: 'المجادلة', 59: 'الحشر', 60: 'الممتحنة',
        61: 'الصف', 62: 'الجمعة', 63: 'المنافقون', 64: 'التغابن', 65: 'الطلاق',
        66: 'التحريم', 67: 'الملك', 68: 'القلم', 69: 'الحاقة', 70: 'المعارج',
        71: 'نوح', 72: 'الجن', 73: 'المزمل', 74: 'المدثر', 75: 'القيامة',
        76: 'الإنسان', 77: 'المرسلات', 78: 'النبأ', 79: 'النازعات', 80: 'عبس',
        81: 'التكوير', 82: 'الانفطار', 83: 'المطففين', 84: 'الانشقاق', 85: 'البروج',
        86: 'الطارق', 87: 'الأعلى', 88: 'الغاشية', 89: 'الفجر', 90: 'البلد',
        91: 'الشمس', 92: 'الليل', 93: 'الضحى', 94: 'الشرح', 95: 'التين',
        96: 'العلق', 97: 'القدر', 98: 'البينة', 99: 'الزلزلة', 100: 'العاديات',
        101: 'القارعة', 102: 'التكاثر', 103: 'العصر', 104: 'الهمزة', 105: 'الفيل',
        106: 'قريش', 107: 'الماعون', 108: 'الكوثر', 109: 'الكافرون', 110: 'النصر',
        111: 'المسد', 112: 'الإخلاص', 113: 'الفلق', 114: 'الناس',
      }

      // ==========================================
      // ARABIC TEXT NORMALIZATION
      // ==========================================
      const ArabicNormalizer = {
        // Convert Ottoman-specific characters to standard Arabic BEFORE removing diacritics
        // This is critical: U+0670 (superscript alef) represents an actual alef sound
        normalizeOttoman(text) {
          return text
            // U+0670 superscript/dagger alef → REMOVE (it's a diacritical mark, not a letter)
            // ASR outputs words without this mark (e.g., الرحمن not الرحمان)
            // For words where a real alef is needed (e.g., العالمين), the imlaei text has U+0627
            .replace(/\u0670/g, '')
            // U+06DF small high rounded zero (Ottoman stop mark) → remove
            .replace(/\u06DF/g, '')
            // U+0653 maddah above → remove (alef already present)
            .replace(/\u0653/g, '')
            // U+0654 hamza above → remove
            .replace(/\u0654/g, '')
            // U+0655 hamza below → remove
            .replace(/\u0655/g, '')
            // U+0656 subscript alef → remove
            .replace(/\u0656/g, '')
            // U+06E5 small waw → remove
            .replace(/\u06E5/g, '')
            // U+06E6 small ya → remove  
            .replace(/\u06E6/g, '')
            // Quran pause/stop marks (صلى، قلى، مـ، لا، ج، ۛ، ۜ) + surrounding space → remove
            // These marks (U+06D6-U+06DC) are embedded in word text and are NOT pronounced
            // NOTE: Use \\s (double backslash) inside template literal so browser receives \s for regex whitespace
            .replace(/\\s*[\\u06D6-\\u06DC]\\s*/g, '')
            // ءا → آ (hamza + alef = alef madda, ASR outputs آ)
            .replace(/ءا/g, 'آ')
        },

        // Remove all diacritics (tashkeel) - U+0670 already handled by normalizeOttoman
        removeDiacritics(text) {
          return text.replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06E0-\u06E8\u06EA-\u06ED\u08D4-\u08E1\u08D4-\u08ED\u08F0-\u08F3]/g, '')
        },

        // Normalize Alif forms
        normalizeAlif(text) {
          return text
            .replace(/[أإآٱ]/g, 'ا')
        },

        // Normalize Ya/Alif Maqsura
        normalizeYa(text) {
          return text.replace(/ى/g, 'ي')
        },

        // Normalize Ta Marbuta
        normalizeTaMarbuta(text) {
          return text.replace(/ة/g, 'ه')
        },

        // Remove tatweel (kashida)
        removeTatweel(text) {
          return text.replace(/ـ/g, '')
        },

        // Full normalization pipeline
        normalize(text, level = 'normal') {
          if (!text) return ''
          let normalized = text.trim()
          
          // Step 1: Convert Ottoman characters FIRST (before removing diacritics)
          normalized = this.normalizeOttoman(normalized)
          
          // Step 2: Remove tatweel and extra spaces
          normalized = this.removeTatweel(normalized)
          normalized = normalized.replace(/\\s+/g, ' ').trim()
          
          if (level === 'strict') {
            // Minimal normalization for strict mode
            normalized = this.normalizeAlif(normalized)
            return normalized
          }
          
          // Normal and easy modes
          normalized = this.removeDiacritics(normalized)
          normalized = normalized.trim()
          normalized = this.normalizeAlif(normalized)
          normalized = this.normalizeYa(normalized)
          
          if (level === 'easy') {
            normalized = this.normalizeTaMarbuta(normalized)
          }
          
          return normalized
        }
      }

      // ==========================================
      // WORD MATCHING ENGINE
      // ==========================================
      const WordMatcher = {
        // Levenshtein distance
        levenshteinDistance(a, b) {
          const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null))
          for (let i = 0; i <= a.length; i++) matrix[0][i] = i
          for (let j = 0; j <= b.length; j++) matrix[j][0] = j
          
          for (let j = 1; j <= b.length; j++) {
            for (let i = 1; i <= a.length; i++) {
              const cost = a[i-1] === b[j-1] ? 0 : 1
              matrix[j][i] = Math.min(
                matrix[j][i-1] + 1,
                matrix[j-1][i] + 1,
                matrix[j-1][i-1] + cost
              )
            }
          }
          return matrix[b.length][a.length]
        },

        // Calculate similarity ratio
        similarity(a, b) {
          if (!a || !b) return 0
          const maxLen = Math.max(a.length, b.length)
          if (maxLen === 0) return 1
          return 1 - (this.levenshteinDistance(a, b) / maxLen)
        },

        // Match spoken text against a single expected text string
        _matchAgainst(spoken, expected, difficulty) {
          const threshold = state.thresholds[difficulty]
          const normalizedSpoken = ArabicNormalizer.normalize(spoken, difficulty)
          const normalizedExpected = ArabicNormalizer.normalize(expected, difficulty)
          
          if (normalizedSpoken === normalizedExpected) {
            return { match: true, confidence: 1.0, type: 'exact' }
          }
          
          const sim = this.similarity(normalizedSpoken, normalizedExpected)
          const distRatio = 1 - sim
          
          if (distRatio <= threshold.levenshtein && sim >= threshold.confidence) {
            return { match: true, confidence: sim, type: 'normalized' }
          }
          
          if (difficulty === 'easy') {
            const phoneticSim = this.phoneticSimilarity(normalizedSpoken, normalizedExpected)
            if (phoneticSim >= threshold.confidence) {
              return { match: true, confidence: phoneticSim, type: 'phonetic' }
            }
          }
          
          return { match: false, confidence: sim, type: 'mismatch' }
        },

        // Match a spoken word against expected word
        // Accepts either a string or a word object with text_uthmani and text_imlaei
        matchWord(spoken, expected, difficulty = 'normal') {
          // If expected is a word object, try text_imlaei first (ASR outputs standard Arabic)
          if (expected && typeof expected === 'object') {
            // Try imlaei text first (closest to what ASR outputs)
            if (expected.text_imlaei) {
              const imlaeiResult = this._matchAgainst(spoken, expected.text_imlaei, difficulty)
              if (imlaeiResult.match) return imlaeiResult
            }
            // Fallback to uthmani text
            const uthmaniResult = this._matchAgainst(spoken, expected.text_uthmani || '', difficulty)
            // Return the better result
            if (expected.text_imlaei) {
              const imlaeiResult = this._matchAgainst(spoken, expected.text_imlaei, difficulty)
              return uthmaniResult.match ? uthmaniResult : 
                     (uthmaniResult.confidence > imlaeiResult.confidence ? uthmaniResult : imlaeiResult)
            }
            return uthmaniResult
          }
          // Plain string - use directly
          return this._matchAgainst(spoken, expected, difficulty)
        },

        // Phonetic similarity for Arabic
        phoneticSimilarity(a, b) {
          // Additional phonetic normalizations
          const phoneticNorm = (text) => {
            return text
              .replace(/[ضظ]/g, 'ز')
              .replace(/[صث]/g, 'س')
              .replace(/[ذ]/g, 'د')
              .replace(/[غ]/g, 'خ')
              .replace(/[ط]/g, 'ت')
              .replace(/[ؤ]/g, 'و')
              .replace(/[ئ]/g, 'ي')
              .replace(/[ء]/g, '')
          }
          return this.similarity(phoneticNorm(a), phoneticNorm(b))
        },

        // Match multiple words from speech against expected sequence
        matchSequence(spokenTokens, expectedWords, startIndex, difficulty, revealedWords) {
          const results = []
          let expectedIdx = startIndex
          
          for (let i = 0; i < spokenTokens.length && expectedIdx < expectedWords.length; i++) {
            const spoken = spokenTokens[i]
            if (!spoken || spoken.trim().length === 0) continue
            
            // IMPORTANT: Try to match the CURRENT expected word FIRST
            // This prevents false "repeat" detection when the same word appears
            // multiple times in the Quran (e.g., "الرحمن" in Basmala AND verse 3 of Al-Fatiha)
            const expected = expectedWords[expectedIdx]
            const result = this.matchWord(spoken, expected, difficulty)
            
            if (result.match) {
              results.push({
                wordIndex: expectedIdx,
                word: expected,
                confidence: result.confidence,
                matchType: result.type,
                spoken: spoken
              })
              expectedIdx++
              // Skip past any already-revealed words
              while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) {
                expectedIdx++
              }
            } else {
              // Try combining with next spoken token (ASR may split Arabic words)
              let combinedMatch = false
              if (i + 1 < spokenTokens.length) {
                // Try combining WITHOUT space first, then WITH space
                const combinedNoSpace = spoken + spokenTokens[i + 1]
                const combinedWithSpace = spoken + ' ' + spokenTokens[i + 1]
                let combResult = this.matchWord(combinedNoSpace, expected, difficulty)
                let usedCombined = combinedNoSpace
                if (!combResult.match) {
                  combResult = this.matchWord(combinedWithSpace, expected, difficulty)
                  usedCombined = combinedWithSpace
                }
                if (combResult.match) {
                  results.push({
                    wordIndex: expectedIdx,
                    word: expected,
                    confidence: combResult.confidence,
                    matchType: combResult.type,
                    spoken: usedCombined
                  })
                  expectedIdx++
                  while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) {
                    expectedIdx++
                  }
                  i++ // Skip next token since we consumed it
                  combinedMatch = true
                }
                
                // Also try: one spoken token matches TWO expected words concatenated
                if (!combinedMatch && expectedIdx + 1 < expectedWords.length) {
                  // Try matching one spoken token against two expected words concatenated
                  // Use imlaei text if available for better ASR matching
                  const exp1Text = expected.text_imlaei || expected.text_uthmani
                  const exp2Text = expectedWords[expectedIdx + 1].text_imlaei || expectedWords[expectedIdx + 1].text_uthmani
                  const twoExpected = exp1Text + ' ' + exp2Text
                  let twoResult = this.matchWord(spoken, twoExpected, difficulty)
                  // Also try with uthmani if imlaei didn't match
                  if (!twoResult.match) {
                    const twoUthmani = expected.text_uthmani + ' ' + expectedWords[expectedIdx + 1].text_uthmani
                    if (twoUthmani !== twoExpected) twoResult = this.matchWord(spoken, twoUthmani, difficulty)
                  }
                  if (twoResult.match) {
                    // This spoken token matches two expected words
                    results.push({
                      wordIndex: expectedIdx,
                      word: expected,
                      confidence: twoResult.confidence,
                      matchType: twoResult.type,
                      spoken: spoken
                    })
                    results.push({
                      wordIndex: expectedIdx + 1,
                      word: expectedWords[expectedIdx + 1],
                      confidence: twoResult.confidence,
                      matchType: twoResult.type,
                      spoken: spoken
                    })
                    expectedIdx += 2
                    while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) {
                      expectedIdx++
                    }
                    combinedMatch = true
                  }
                }
              }
              
              if (!combinedMatch) {
                // Before recording an error, check if the spoken word is a REPEAT
                // of an already-revealed word (user accidentally re-said a previous word)
                // Only skip if it does NOT match the current expected word (already checked above)
                if (revealedWords && revealedWords.size > 0) {
                  const isRepeat = this.isRepeatOfRevealed(spoken, expectedWords, expectedIdx, difficulty, revealedWords)
                  if (isRepeat) {
                    // User repeated an already-revealed word, skip this token silently
                    continue
                  }
                }
                
                // Check if it's an order error (word exists in scope but wrong position)
                const isOrderError = this.checkOrderError(spoken, expectedWords, expectedIdx, difficulty)
                results.push({
                  wordIndex: expectedIdx,
                  word: expected,
                  confidence: result.confidence,
                  matchType: 'error',
                  errorType: isOrderError ? 'order' : (result.confidence > 0.4 ? 'pronunciation' : 'substitution'),
                  spoken: spoken
                })
                break // Stop at first real error
              }
            }
          }
          
          return results
        },

        // Check if the spoken word is a repeat of an already-revealed word
        // IMPORTANT: Only consider words that are NOT adjacent to current position
        // (adjacent revealed words are likely legitimate - user just re-read to current point)
        isRepeatOfRevealed(spoken, expectedWords, currentIdx, difficulty, revealedWords) {
          const normalizedSpoken = ArabicNormalizer.normalize(spoken, difficulty)
          for (const idx of revealedWords) {
            if (idx >= expectedWords.length) continue
            // Skip words close to current position (within 2 words) - 
            // these are likely the user re-reading from a nearby position which is normal
            if (Math.abs(idx - currentIdx) <= 2) continue
            const word = expectedWords[idx]
            const textsToCheck = [word.text_imlaei, word.text_uthmani].filter(Boolean)
            for (const text of textsToCheck) {
              const normalizedExpected = ArabicNormalizer.normalize(text, difficulty)
              if (normalizedSpoken === normalizedExpected) return true
              // Use stricter threshold for repeat detection
              const sim = this.similarity(normalizedSpoken, normalizedExpected)
              if (sim >= 0.90) return true
            }
          }
          return false
        },

        // Check if spoken word exists elsewhere in scope (order error)
        checkOrderError(spoken, expectedWords, currentIndex, difficulty) {
          const normalizedSpoken = ArabicNormalizer.normalize(spoken, difficulty)
          for (let i = currentIndex + 1; i < Math.min(currentIndex + 20, expectedWords.length); i++) {
            const word = expectedWords[i]
            const textsToCheck = [word.text_imlaei, word.text_uthmani].filter(Boolean)
            for (const text of textsToCheck) {
              const normalizedExpected = ArabicNormalizer.normalize(text, difficulty)
              if (normalizedSpoken === normalizedExpected) return true
            }
          }
          return false
        }
      }

      // ==========================================
      // SPEECH RECOGNITION MANAGER
      // ==========================================
      const SpeechManager = {
        init() {
          const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
          if (!SpeechRecognition) {
            showToast('المتصفح لا يدعم التعرف على الكلام. يرجى استخدام Chrome أو Edge.', 'error')
            return false
          }
          
          state.recognition = new SpeechRecognition()
          state.recognition.lang = 'ar-SA'
          state.recognition.continuous = true
          state.recognition.interimResults = true
          state.recognition.maxAlternatives = 3
          
          state.recognition.onresult = (event) => {
            this.handleResult(event)
          }
          
          state.recognition.onaudiostart = () => {
            state.isListening = true
            state._isRestarting = false
            state._restartAttempts = 0
            debugAddEntry('system', '🎙️ ميكروفون نشط', '')
            softRender()
          }
          
          state.recognition.onerror = (event) => {
            this.handleError(event)
          }
          
          state.recognition.onend = () => {
            // CRITICAL: Always auto-restart if session is active
            if (state.sessionActive && !state.sessionPaused) {
              state.isListening = false
              state._isRestarting = true
              state._restartAttempts++
              
              // Exponential backoff: 50ms, 100ms, 200ms, 400ms... max 2000ms
              const delay = Math.min(50 * Math.pow(2, Math.min(state._restartAttempts - 1, 5)), 2000)
              
              debugAddEntry('system', '🔄 إعادة تشغيل (#' + state._restartAttempts + ') بعد ' + delay + 'ms', '')
              
              setTimeout(() => {
                if (state.sessionActive && !state.sessionPaused) {
                  this._doRestart()
                }
              }, delay)
            } else {
              state.isListening = false
              state._isRestarting = false
              softRender()
            }
          }
          
          return true
        },

        // Internal restart with re-init fallback
        _doRestart() {
          try {
            state.recognition.start()
          } catch(e) {
            // If start fails (e.g. already started, or stale object), re-init
            debugAddEntry('system', '⚠️ إعادة تهيئة التعرف على الكلام', e.message || '')
            try { state.recognition.abort() } catch(e2) {}
            state.recognition = null
            if (this.init()) {
              try {
                state.recognition.start()
              } catch(e3) {
                // Last resort: wait and retry
                setTimeout(() => {
                  if (state.sessionActive && !state.sessionPaused) {
                    this._doRestart()
                  }
                }, 1000)
              }
            }
          }
        },

        start() {
          if (!state.recognition) {
            if (!this.init()) return
          }
          state._restartAttempts = 0
          try {
            state.recognition.start()
            state.isListening = true
            state.lastSpeechTime = Date.now()
            state.asrFailCount = 0
            state._lastInterim = ''
            this.startSilenceMonitor()
            this.startKeepAlive()
            render()
          } catch(e) {
            try { state.recognition.abort() } catch(e2) {}
            setTimeout(() => {
              this._doRestart()
              state.isListening = true
              softRender()
            }, 300)
          }
        },

        stop() {
          state._isRestarting = false
          state._restartAttempts = 0
          if (state.recognition) {
            try { state.recognition.abort() } catch(e) {}
          }
          state.isListening = false
          state._lastInterim = ''
          this.stopSilenceMonitor()
          this.stopKeepAlive()
          render()
        },

        // Keep-alive: periodically check if recognition is still running
        startKeepAlive() {
          this.stopKeepAlive()
          state._keepAliveTimer = setInterval(() => {
            if (!state.sessionActive || state.sessionPaused) return
            // If not listening and not in restart cycle, force restart
            if (!state.isListening && !state._isRestarting) {
              debugAddEntry('system', '🔧 Keep-alive: إعادة تشغيل تلقائية', '')
              state._restartAttempts = 0
              this._doRestart()
            }
          }, 3000)
        },

        stopKeepAlive() {
          if (state._keepAliveTimer) {
            clearInterval(state._keepAliveTimer)
            state._keepAliveTimer = null
          }
        },

        handleResult(event) {
          state.lastSpeechTime = Date.now()
          state.asrFailCount = 0
          
          let finalTranscript = ''
          let interimTranscript = ''
          const alternativeTranscripts = []
          
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i]
            const transcript = result[0].transcript
            
            if (result.isFinal) {
              finalTranscript += transcript
              for (let alt = 1; alt < result.length; alt++) {
                alternativeTranscripts.push(result[alt].transcript)
              }
            } else {
              interimTranscript += transcript
            }
          }
          
          // Process final transcript
          if (finalTranscript.trim()) {
            state._lastInterim = ''
            const beforeIndex = state.currentWordIndex
            this.processTranscript(finalTranscript.trim(), false)
            
            // If primary didn't match, try alternatives
            if (state.currentWordIndex === beforeIndex && alternativeTranscripts.length > 0) {
              for (const alt of alternativeTranscripts) {
                if (alt.trim()) {
                  debugAddEntry('alt', alt.trim(), '')
                  this.processTranscript(alt.trim(), true)
                  if (state.currentWordIndex > beforeIndex) break
                }
              }
            }
          }
          
          // Process interim results for faster response
          if (interimTranscript.trim() && interimTranscript !== state._lastInterim) {
            state._lastInterim = interimTranscript
            this.processInterim(interimTranscript.trim())
            updateInterimDisplay(interimTranscript.trim())
          }
        },

        // Process interim results - match only confident exact matches
        processInterim(transcript) {
          if (!state.sessionActive || state.sessionPaused || !state.pageData) return
          
          const words = state.pageData.words
          if (state.currentWordIndex >= words.length) return
          
          const spokenTokens = transcript.split(/\\s+/).filter(t => t.length > 0)
          if (spokenTokens.length === 0) return
          
          const revealedSnapshot = new Set(state.revealedWords)
          
          // Use ALL interim tokens (don't drop last one - it causes delays)
          // matchSequence will handle partial matches via similarity threshold
          const results = WordMatcher.matchSequence(
            spokenTokens,
            words,
            state.currentWordIndex,
            state.difficulty,
            revealedSnapshot
          )
          
          for (const result of results) {
            if (result.matchType !== 'error' && result.confidence >= 0.85) {
              // Only reveal on high-confidence interim matches
              revealWord(result.wordIndex)
              state.lastSpeechTime = Date.now()
              debugAddEntry('interim-match', result.spoken, words[result.wordIndex].text_uthmani + ' ✓ (' + Math.round(result.confidence * 100) + '%)')
            } else {
              break
            }
          }
        },

        processTranscript(transcript, isAlternative) {
          if (!state.sessionActive || state.sessionPaused || !state.pageData) return
          
          const words = state.pageData.words
          if (state.currentWordIndex >= words.length) return
          
          const spokenTokens = transcript.split(/\\s+/).filter(t => t.length > 0)
          
          if (spokenTokens.length === 0) {
            state.asrFailCount++
            if (state.asrFailCount >= 3) {
              showToast('الصوت غير واضح', 'warning')
              state.asrFailCount = 0
            }
            return
          }
          
          // Debug: log what we heard
          if (!isAlternative) {
            const currentWord = words[state.currentWordIndex]
            const expectedNorm = ArabicNormalizer.normalize(currentWord.text_imlaei || currentWord.text_uthmani, state.difficulty)
            debugAddEntry('heard', transcript, 'متوقع: ' + (currentWord.text_imlaei || currentWord.text_uthmani) + ' → ' + expectedNorm)
          }
          
          const revealedSnapshot = new Set(state.revealedWords)
          
          // --- Phase 1: Try matching from current expected index ---
          const results = WordMatcher.matchSequence(
            spokenTokens,
            words,
            state.currentWordIndex,
            state.difficulty,
            revealedSnapshot
          )
          
          let anyRevealed = false
          let pendingError = null
          
          for (const result of results) {
            if (result.matchType !== 'error') {
              revealWord(result.wordIndex)
              anyRevealed = true
              debugAddEntry('match', result.spoken, words[result.wordIndex].text_uthmani + ' ✓ [' + result.matchType + ' ' + Math.round(result.confidence * 100) + '%]')
            } else {
              pendingError = result
              debugAddEntry('no-match', result.spoken, words[result.wordIndex].text_uthmani + ' ✗ [' + Math.round(result.confidence * 100) + '%] ' + (result.errorType || ''))
              break
            }
          }
          
          // --- Phase 2: Re-read detection ---
          if (!anyRevealed && pendingError) {
            let rereadDetected = false
            
            for (let tokenStart = 0; tokenStart < spokenTokens.length; tokenStart++) {
              const spokenWord = spokenTokens[tokenStart]
              
              for (let backIdx = state.currentWordIndex - 1; backIdx >= Math.max(0, state.currentWordIndex - 30); backIdx--) {
                if (!state.revealedWords.has(backIdx)) continue
                const backMatch = WordMatcher.matchWord(spokenWord, words[backIdx], state.difficulty)
                if (backMatch.match) {
                  rereadDetected = true
                  debugAddEntry('re-read', spokenWord, 'أعاد قراءة كلمة #' + backIdx + ' ' + words[backIdx].text_uthmani)
                  
                  const remainingTokens = spokenTokens.slice(tokenStart + 1)
                  if (remainingTokens.length > 0) {
                    const retryResults = WordMatcher.matchSequence(
                      remainingTokens, words, state.currentWordIndex, state.difficulty, revealedSnapshot
                    )
                    for (const r of retryResults) {
                      if (r.matchType !== 'error') {
                        revealWord(r.wordIndex)
                        anyRevealed = true
                        debugAddEntry('match', r.spoken, words[r.wordIndex].text_uthmani + ' ✓ (بعد إعادة)')
                      } else {
                        break
                      }
                    }
                  }
                  break
                }
              }
              if (rereadDetected) break
            }
            
            if (rereadDetected) {
              state.lastSpeechTime = Date.now()
              pendingError = null
            }
          }
          
          // --- Phase 3: Try skipping current word ---
          // If no match and first token was close but not enough,
          // try matching against next word (ASR might have merged/skipped)
          if (!anyRevealed && pendingError && state.currentWordIndex + 1 < words.length) {
            const skipResults = WordMatcher.matchSequence(
              spokenTokens, words, state.currentWordIndex + 1, state.difficulty, revealedSnapshot
            )
            if (skipResults.length > 0 && skipResults[0].matchType !== 'error') {
              // Tokens match starting from next word - don't record error,
              // just reveal the matching words
              for (const r of skipResults) {
                if (r.matchType !== 'error') {
                  revealWord(r.wordIndex)
                  anyRevealed = true
                  debugAddEntry('skip-match', r.spoken, words[r.wordIndex].text_uthmani + ' ✓ (تخطي)')
                } else break
              }
              pendingError = null
            }
          }
          
          // Phase 4: Record error only if all phases failed
          if (pendingError && !isAlternative) {
            recordAttempt(pendingError.wordIndex, pendingError.spoken, pendingError.errorType)
            flashError(pendingError.wordIndex)
            if (navigator.vibrate) navigator.vibrate(50)
          }
          
          if (anyRevealed) {
            state.lastSpeechTime = Date.now()
          }
        },

        handleError(event) {
          if (event.error === 'no-speech') {
            debugAddEntry('system', '🔇 لا يوجد كلام', '')
            return
          }
          if (event.error === 'aborted') return
          if (event.error === 'network') {
            debugAddEntry('system', '❌ خطأ شبكة', '')
            showToast('خطأ في الشبكة - تحقق من الاتصال', 'error')
            return
          }
          
          debugAddEntry('system', '⚠️ خطأ ASR: ' + event.error, '')
          state.asrFailCount++
          if (state.asrFailCount >= 5) {
            showToast('الصوت غير واضح', 'warning')
            state.asrFailCount = 0
          }
        },

        startSilenceMonitor() {
          this.stopSilenceMonitor()
          state.silenceTimer = setInterval(() => {
            if (!state.sessionActive || state.sessionPaused) return
            
            const elapsed = (Date.now() - (state.lastSpeechTime || Date.now())) / 1000
            
            // Increase silence threshold from 10s to 15s to reduce false forgets
            if (elapsed >= 15) {
              const words = state.pageData?.words
              if (words && state.currentWordIndex < words.length) {
                recordForgetError(state.currentWordIndex)
                state.lastSpeechTime = Date.now()
              }
            }
            
            softRender()
          }, 2000)
        },

        stopSilenceMonitor() {
          if (state.silenceTimer) {
            clearInterval(state.silenceTimer)
            state.silenceTimer = null
          }
        }
      }

      // ==========================================
      // SESSION MANAGEMENT
      // ==========================================
      function startSession() {
        if (!state.pageData) return
        
        state.sessionActive = true
        state.sessionPaused = false
        state.sessionStartTime = Date.now()
        state.currentWordIndex = 0
        state.revealedWords = new Set()
        state.wordAttempts = {}
        state.errorLogs = []
        state.sessionStats = {
          totalWords: state.pageData.words.length,
          correctWords: 0,
          errors: 0,
        }
        
        state.debugLog = [] // Clear debug log on new session
        SpeechManager.start()
        render()
      }

      // Debug logging system
      function debugAddEntry(type, spoken, detail) {
        const entry = {
          time: new Date().toLocaleTimeString('ar-EG'),
          type: type,
          spoken: spoken,
          detail: detail,
          wordIndex: state.currentWordIndex
        }
        state.debugLog.unshift(entry) // newest first
        if (state.debugLog.length > 50) state.debugLog.pop() // keep last 50
        
        // Update debug panel if visible
        if (state.showDebugPanel) {
          updateDebugPanel()
        }
      }

      function toggleDebugPanel() {
        state.showDebugPanel = !state.showDebugPanel
        localStorage.setItem('showDebugPanel', state.showDebugPanel.toString())
        render()
      }

      function updateDebugPanel() {
        const el = document.getElementById('debug-panel-content')
        if (!el) return
        let html = ''
        for (const entry of state.debugLog) {
          const colors = {
            'heard': 'text-blue-400',
            'match': 'text-green-400',
            'no-match': 'text-red-400',
            'interim-match': 'text-cyan-400',
            're-read': 'text-yellow-400',
            'skip-match': 'text-purple-400',
            'alt': 'text-orange-400',
            'system': 'text-gray-400',
          }
          const color = colors[entry.type] || 'text-gray-300'
          const typeLabel = {
            'heard': '🔊 سمع',
            'match': '✅ طابق',
            'no-match': '❌ لم يطابق',
            'interim-match': '⚡ مؤقت',
            're-read': '🔁 إعادة',
            'skip-match': '⏭️ تخطي',
            'alt': '🔄 بديل',
            'system': '⚙️ نظام',
          }
          html += '<div class=\"text-xs font-mono leading-5 border-b border-gray-700 py-1\">'
          html += '<span class=\"text-gray-500\">' + entry.time + '</span> '
          html += '<span class=\"' + color + ' font-bold\">[' + (typeLabel[entry.type] || entry.type) + ']</span> '
          html += '<span class=\"text-white font-arabic\">' + entry.spoken + '</span>'
          if (entry.detail) {
            html += '<br><span class=\"text-gray-400 mr-4 font-arabic\">' + entry.detail + '</span>'
          }
          html += '</div>'
        }
        el.innerHTML = html || '<div class=\"text-gray-500 text-center py-4 font-arabic\">ابدأ التسميع لرؤية سجل المطابقة</div>'
      }

      function pauseSession() {
        state.sessionPaused = true
        SpeechManager.stop()
        render()
      }

      function resumeSession() {
        state.sessionPaused = false
        state.lastSpeechTime = Date.now()
        SpeechManager.start()
        render()
      }

      function endSession() {
        SpeechManager.stop()
        
        const session = {
          id: 'session_' + Date.now(),
          start_time: new Date(state.sessionStartTime).toISOString(),
          end_time: new Date().toISOString(),
          mode: 'page',
          difficulty: state.difficulty,
          scope_type: 'page',
          scope_value: state.currentPage.toString(),
          total_words: state.sessionStats.totalWords,
          correct_words: state.sessionStats.correctWords,
          errors_count: state.sessionStats.errors,
          duration_seconds: Math.floor((Date.now() - state.sessionStartTime) / 1000),
          error_details: state.errorLogs,
          page_number: state.currentPage,
        }
        
        // Save to local storage
        state.sessionHistory.unshift(session)
        if (state.sessionHistory.length > 100) state.sessionHistory.pop()
        localStorage.setItem('sessionHistory', JSON.stringify(state.sessionHistory))
        
        // Try to save to server
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(session)
        }).catch(() => {})
        
        if (state.errorLogs.length > 0) {
          fetch('/api/sessions/' + session.id + '/errors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ errors: state.errorLogs })
          }).catch(() => {})
        }
        
        state.sessionActive = false
        state.sessionPaused = false
        
        // Show results
        showSessionResults(session)
        render()
      }

      function revealWord(index) {
        if (state.revealedWords.has(index)) return
        
        state.revealedWords.add(index)
        state.sessionStats.correctWords++
        
        // Advance to next unrevealed word
        while (state.revealedWords.has(state.currentWordIndex) && state.currentWordIndex < state.pageData.words.length) {
          state.currentWordIndex++
        }
        
        // Use targeted DOM update - don't rebuild entire page
        revealWordInDOM(index)
        updateControlsInDOM()
        
        // Check if page is complete
        if (state.currentWordIndex >= state.pageData.words.length) {
          showToast('أحسنت! اكتملت الصفحة', 'success')
          setTimeout(() => endSession(), 1500)
        }
      }

      // Targeted DOM update for revealing a word - doesn't destroy/recreate elements
      function revealWordInDOM(index) {
        const el = document.querySelector('[data-word-index="' + index + '"]')
        if (el) {
          const span = el.querySelector('.qcf-word') || el.querySelector('span')
          if (span) {
            span.classList.remove('word-hidden')
            span.classList.add('word-revealed')
          }
          el.classList.remove('current-word')
        }
        // Highlight new current word
        const nextEl = document.querySelector('[data-word-index="' + state.currentWordIndex + '"]')
        if (nextEl) {
          nextEl.classList.add('current-word')
        }
      }

      // Update only the bottom controls area without touching the Quran text
      function updateControlsInDOM() {
        const controlsEl = document.getElementById('session-controls')
        if (controlsEl) {
          controlsEl.innerHTML = renderBottomControlsInner()
        }
      }

      // Soft render: updates only dynamic parts during active session
      function softRender() {
        if (state.sessionActive && state.currentView === 'mushaf') {
          updateControlsInDOM()
        } else {
          render()
        }
      }

      function recordAttempt(wordIndex, spokenText, errorType) {
        const key = wordIndex.toString()
        if (!state.wordAttempts[key]) {
          state.wordAttempts[key] = { count: 0, errors: [] }
        }
        state.wordAttempts[key].count++
        
        const attempt = state.wordAttempts[key]
        
        // Error recording rules:
        // Attempt 1: No error recorded
        // Attempt 2: Soft error
        // Attempt 3+: Confirmed error
        if (attempt.count >= 2) {
          const word = state.pageData.words[wordIndex]
          const errorLog = {
            word_location: word.location,
            expected_text: word.text_uthmani,
            recognized_text: spokenText || '',
            error_type: errorType || 'substitution',
            attempts: attempt.count,
            page_number: word.page_number,
            line_number: word.line_number,
            severity: attempt.count === 2 ? 'soft' : 'confirmed'
          }
          
          // Check if error already exists for this word
          const existing = state.errorLogs.findIndex(e => e.word_location === word.location)
          if (existing >= 0) {
            state.errorLogs[existing] = errorLog
          } else {
            state.errorLogs.push(errorLog)
            state.sessionStats.errors++
          }
        }
      }

      function recordForgetError(wordIndex) {
        const word = state.pageData.words[wordIndex]
        if (!word) return
        
        const key = wordIndex.toString()
        if (!state.wordAttempts[key]) {
          state.wordAttempts[key] = { count: 0, errors: [] }
        }
        state.wordAttempts[key].count++
        
        if (state.wordAttempts[key].count >= 2) {
          const errorLog = {
            word_location: word.location,
            expected_text: word.text_uthmani,
            recognized_text: '',
            error_type: 'forget',
            attempts: state.wordAttempts[key].count,
            page_number: word.page_number,
            line_number: word.line_number,
            severity: 'confirmed'
          }
          
          const existing = state.errorLogs.findIndex(e => e.word_location === word.location)
          if (existing >= 0) {
            state.errorLogs[existing] = errorLog
          } else {
            state.errorLogs.push(errorLog)
            state.sessionStats.errors++
          }
        }
        
        showToast('نسيت... حاول مرة أخرى أو اطلب المساعدة', 'info')
      }

      // Manual assistance
      function revealNextWord() {
        if (!state.sessionActive || state.currentWordIndex >= state.pageData.words.length) return
        
        const word = state.pageData.words[state.currentWordIndex]
        
        // Log as forgotten
        const errorLog = {
          word_location: word.location,
          expected_text: word.text_uthmani,
          recognized_text: '',
          error_type: 'forget',
          attempts: (state.wordAttempts[state.currentWordIndex.toString()]?.count || 0) + 1,
          page_number: word.page_number,
          line_number: word.line_number,
          severity: 'manual_reveal'
        }
        
        const existing = state.errorLogs.findIndex(e => e.word_location === word.location)
        if (existing >= 0) {
          state.errorLogs[existing] = errorLog
        } else {
          state.errorLogs.push(errorLog)
          state.sessionStats.errors++
        }
        
        revealWord(state.currentWordIndex)
      }

      function revealCurrentAyah() {
        if (!state.sessionActive || !state.pageData) return
        
        const currentWord = state.pageData.words[state.currentWordIndex]
        if (!currentWord) return
        
        const currentVerseKey = currentWord.verse_key
        
        // Find all words in current ayah
        for (let i = state.currentWordIndex; i < state.pageData.words.length; i++) {
          const word = state.pageData.words[i]
          if (word.verse_key !== currentVerseKey) break
          
          if (!state.revealedWords.has(i)) {
            // Log as forgotten
            const errorLog = {
              word_location: word.location,
              expected_text: word.text_uthmani,
              recognized_text: '',
              error_type: 'forget',
              attempts: 1,
              page_number: word.page_number,
              line_number: word.line_number,
              severity: 'manual_reveal'
            }
            state.errorLogs.push(errorLog)
            state.sessionStats.errors++
            
            state.revealedWords.add(i)
            state.sessionStats.correctWords++
          }
        }
        
        // Advance past the ayah
        while (state.revealedWords.has(state.currentWordIndex) && state.currentWordIndex < state.pageData.words.length) {
          state.currentWordIndex++
        }
        
        state.lastSpeechTime = Date.now()
        // Full render needed since multiple words changed
        render()
      }

      function flashError(wordIndex) {
        setTimeout(() => {
          const el = document.querySelector('[data-word-index="' + wordIndex + '"]')
          if (el) {
            el.classList.add('error-flash')
            setTimeout(() => el.classList.remove('error-flash'), 500)
          }
        }, 50)
      }

      // ==========================================
      // DATA LOADING
      // ==========================================
      async function loadPage(pageNumber) {
        state.loading = true
        state.currentPage = pageNumber
        localStorage.setItem('lastPage', pageNumber.toString())
        render()
        
        try {
          // Start loading both data and font in parallel
          const [res] = await Promise.all([
            fetch('/api/quran/page/' + pageNumber),
            QCFFontLoader.loadPageFont(pageNumber)
          ])
          const data = await res.json()
          state.pageData = data
        } catch(err) {
          showToast('خطأ في تحميل البيانات', 'error')
        }
        
        state.loading = false
        render()
        
        // If font wasn't loaded yet during render, update words after font loads
        if (!QCFFontLoader.isFontLoaded(pageNumber)) {
          QCFFontLoader.loadPageFont(pageNumber).then(() => {
            updateQCFWordsInDOM(pageNumber)
          })
        }
      }
      
      // Update fallback words with QCF font after it loads
      function updateQCFWordsInDOM(pageNumber) {
        document.querySelectorAll('.qcf-word.loading').forEach(function(span) {
          const page = span.getAttribute('data-page')
          if (parseInt(page) === pageNumber) {
            const codeV2 = span.getAttribute('data-code-v2')
            if (codeV2) {
              span.classList.remove('loading')
              span.classList.add('qcf-p' + pageNumber)
              span.innerHTML = decodeHTMLAttr(codeV2)
            }
          }
        })
      }
      
      function decodeHTMLAttr(str) {
        if (!str) return ''
        return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      }

      async function loadSurahs() {
        if (state.surahs) return
        try {
          const res = await fetch('/api/quran/surahs')
          const data = await res.json()
          state.surahs = data.chapters
        } catch(err) {
          console.error('Failed to load surahs:', err)
        }
      }

      // ==========================================
      // UI HELPERS
      // ==========================================
      function showToast(message, type = 'info') {
        const id = Date.now()
        state.toasts.push({ id, message, type })
        // Use direct DOM manipulation for toasts to avoid destroying speech recognition
        updateToastsDOM()
        setTimeout(() => {
          state.toasts = state.toasts.filter(t => t.id !== id)
          updateToastsDOM()
        }, 3000)
      }

      function updateToastsDOM() {
        let container = document.getElementById('toast-container')
        if (!container) {
          container = document.createElement('div')
          container.id = 'toast-container'
          container.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 z-50 space-y-2'
          document.body.appendChild(container)
        }
        const colors = { success: 'bg-green-500', error: 'bg-red-500', warning: 'bg-yellow-500', info: 'bg-blue-500' }
        container.innerHTML = state.toasts.map(t =>
          '<div class="toast ' + (colors[t.type] || colors.info) + ' text-white px-6 py-3 rounded-lg shadow-lg font-arabic text-sm">' + t.message + '</div>'
        ).join('')
      }

      function updateInterimDisplay(text) {
        const el = document.getElementById('interim-text')
        if (el) el.textContent = text
      }

      let sessionResultsData = null
      function showSessionResults(session) {
        sessionResultsData = session
        state.currentView = 'results'
        render()
      }

      function toggleDarkMode() {
        state.darkMode = !state.darkMode
        localStorage.setItem('darkMode', state.darkMode.toString())
        document.documentElement.classList.toggle('dark', state.darkMode)
        render()
      }

      function setDifficulty(level) {
        state.difficulty = level
        localStorage.setItem('difficulty', level)
        render()
      }

      function completeOnboarding() {
        state.showOnboarding = false
        localStorage.setItem('onboardingDone', 'true')
        render()
      }

      // ==========================================
      // RENDER ENGINE
      // ==========================================
      function render() {
        const app = document.getElementById('app')
        if (!app) return
        
        document.documentElement.classList.toggle('dark', state.darkMode)
        
        let html = ''
        
        // Onboarding
        if (state.showOnboarding) {
          html += renderOnboarding()
        }
        
        // Main content
        switch(state.currentView) {
          case 'home':
            html += renderHome()
            break
          case 'mushaf':
            html += renderMushaf()
            break
          case 'results':
            html += renderResults()
            break
          case 'analytics':
            html += renderAnalytics()
            break
          case 'settings':
            html += renderSettings()
            break
          case 'surah-list':
            html += renderSurahList()
            break
          case 'session-detail':
            html += renderSessionDetail()
            break
        }
        
        app.innerHTML = html
        
        // Bind events after render
        bindEvents()
      }

      function renderToasts() {
        if (state.toasts.length === 0) return ''
        
        return '<div class="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 space-y-2">' +
          state.toasts.map(t => {
            const colors = {
              success: 'bg-green-500',
              error: 'bg-red-500',
              warning: 'bg-yellow-500',
              info: 'bg-blue-500'
            }
            return '<div class="toast ' + (colors[t.type] || colors.info) + ' text-white px-6 py-3 rounded-lg shadow-lg font-arabic text-sm">' + t.message + '</div>'
          }).join('') +
        '</div>'
      }

      // ==========================================
      // ONBOARDING
      // ==========================================
      function renderOnboarding() {
        return '<div class="onboarding-overlay fixed inset-0 bg-black/60 z-40 flex items-center justify-center p-4">' +
          '<div class="bg-white dark:bg-gray-800 rounded-2xl max-w-md w-full p-8 slide-up">' +
            '<div class="text-center mb-8">' +
              '<div class="w-20 h-20 bg-quran-gold/20 rounded-full flex items-center justify-center mx-auto mb-4">' +
                '<i class="fas fa-book-quran text-3xl text-quran-gold"></i>' +
              '</div>' +
              '<h2 class="text-2xl font-bold text-gray-800 dark:text-white font-arabic mb-2">تسميع القرآن</h2>' +
              '<p class="text-gray-500 dark:text-gray-400 font-arabic text-sm">تطبيق حفظ القرآن الكريم كلمة بكلمة</p>' +
            '</div>' +
            
            '<div class="space-y-4 mb-8">' +
              '<div class="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                '<div class="w-8 h-8 bg-quran-gold/20 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-quran-gold font-bold">1</span></div>' +
                '<div><p class="font-arabic text-sm text-gray-700 dark:text-gray-300 font-semibold">اختر الصفحة</p><p class="font-arabic text-xs text-gray-500 dark:text-gray-400">تصفح المصحف واختر الصفحة التي تريد تسميعها</p></div>' +
              '</div>' +
              '<div class="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                '<div class="w-8 h-8 bg-quran-gold/20 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-quran-gold font-bold">2</span></div>' +
                '<div><p class="font-arabic text-sm text-gray-700 dark:text-gray-300 font-semibold">ابدأ التسميع</p><p class="font-arabic text-xs text-gray-500 dark:text-gray-400">سيتم إخفاء النص وسيبدأ التطبيق بالاستماع لك</p></div>' +
              '</div>' +
              '<div class="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                '<div class="w-8 h-8 bg-quran-gold/20 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"><span class="text-quran-gold font-bold">3</span></div>' +
                '<div><p class="font-arabic text-sm text-gray-700 dark:text-gray-300 font-semibold">اقرأ وتابع</p><p class="font-arabic text-xs text-gray-500 dark:text-gray-400">كل كلمة صحيحة ستظهر في مكانها. يمكنك القراءة بشكل متواصل</p></div>' +
              '</div>' +
            '</div>' +
            
            '<button onclick="App.completeOnboarding()" class="w-full bg-quran-gold hover:bg-yellow-600 text-white font-arabic font-bold py-3 px-6 rounded-xl transition-colors">' +
              'ابدأ الآن' +
            '</button>' +
          '</div>' +
        '</div>'
      }

      // ==========================================
      // HOME VIEW
      // ==========================================
      function renderHome() {
        return '<div class="min-h-screen">' +
          // Header
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<div class="flex items-center gap-3">' +
                '<div class="w-10 h-10 bg-quran-gold/20 rounded-xl flex items-center justify-center">' +
                  '<i class="fas fa-book-quran text-quran-gold text-lg"></i>' +
                '</div>' +
                '<div>' +
                  '<h1 class="text-lg font-bold text-gray-800 dark:text-white font-arabic">تسميع القرآن</h1>' +
                  '<p class="text-xs text-gray-500 dark:text-gray-400 font-arabic">Quran Tasmee3</p>' +
                '</div>' +
              '</div>' +
              '<div class="flex items-center gap-2">' +
                '<button onclick="App.toggleDarkMode()" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">' +
                  '<i class="fas ' + (state.darkMode ? 'fa-sun text-yellow-400' : 'fa-moon text-gray-600') + '"></i>' +
                '</button>' +
                '<button onclick="App.navigate(&apos;settings&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">' +
                  '<i class="fas fa-cog text-gray-600 dark:text-gray-400"></i>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-6 space-y-6">' +
            // Quick actions
            '<div class="grid grid-cols-2 gap-4">' +
              '<button onclick="App.navigate(&apos;mushaf&apos;)" class="bg-gradient-to-br from-quran-gold to-yellow-600 text-white rounded-2xl p-6 text-center shadow-lg hover:shadow-xl transition-all">' +
                '<i class="fas fa-book-open text-3xl mb-3 block"></i>' +
                '<span class="font-arabic font-bold text-lg block">المصحف</span>' +
                '<span class="font-arabic text-xs opacity-80">صفحة ' + state.currentPage + '</span>' +
              '</button>' +
              '<button onclick="App.navigate(&apos;surah-list&apos;)" class="bg-gradient-to-br from-emerald-500 to-green-600 text-white rounded-2xl p-6 text-center shadow-lg hover:shadow-xl transition-all">' +
                '<i class="fas fa-list text-3xl mb-3 block"></i>' +
                '<span class="font-arabic font-bold text-lg block">السور</span>' +
                '<span class="font-arabic text-xs opacity-80">اختر سورة للتسميع</span>' +
              '</button>' +
            '</div>' +
            
            // Resume last session
            (state.sessionHistory.length > 0 ? 
              '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">' +
                '<div class="flex items-center justify-between mb-3">' +
                  '<h3 class="font-arabic font-bold text-gray-800 dark:text-white"><i class="fas fa-history text-quran-gold ml-2"></i>آخر جلسة</h3>' +
                  '<button onclick="App.navigate(&apos;analytics&apos;)" class="text-quran-gold text-sm font-arabic hover:underline">عرض الكل</button>' +
                '</div>' +
                '<div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">' +
                  '<div>' +
                    '<p class="font-arabic text-sm text-gray-700 dark:text-gray-300">صفحة ' + state.sessionHistory[0].scope_value + '</p>' +
                    '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">' + formatDate(state.sessionHistory[0].start_time) + ' - ' + formatDuration(state.sessionHistory[0].duration_seconds) + '</p>' +
                  '</div>' +
                  '<div class="text-left">' +
                    '<p class="text-lg font-bold ' + (getAccuracy(state.sessionHistory[0]) > 80 ? 'text-green-500' : getAccuracy(state.sessionHistory[0]) > 50 ? 'text-yellow-500' : 'text-red-500') + '">' + getAccuracy(state.sessionHistory[0]) + '%</p>' +
                    '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">دقة</p>' +
                  '</div>' +
                '</div>' +
              '</div>'
            : '') +
            
            // Quick stats
            '<div class="grid grid-cols-3 gap-3">' +
              '<div class="stats-card bg-white dark:bg-gray-800 rounded-xl p-4 text-center shadow-sm border border-gray-100 dark:border-gray-700">' +
                '<p class="text-2xl font-bold text-quran-gold">' + state.sessionHistory.length + '</p>' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">جلسات</p>' +
              '</div>' +
              '<div class="stats-card bg-white dark:bg-gray-800 rounded-xl p-4 text-center shadow-sm border border-gray-100 dark:border-gray-700">' +
                '<p class="text-2xl font-bold text-green-500">' + getTotalCorrectWords() + '</p>' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">كلمات صحيحة</p>' +
              '</div>' +
              '<div class="stats-card bg-white dark:bg-gray-800 rounded-xl p-4 text-center shadow-sm border border-gray-100 dark:border-gray-700">' +
                '<p class="text-2xl font-bold text-blue-500">' + getUniquePagesCount() + '</p>' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">صفحات</p>' +
              '</div>' +
            '</div>' +
            
            // Difficulty selector
            '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">' +
              '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-3"><i class="fas fa-sliders text-quran-gold ml-2"></i>مستوى الصعوبة</h3>' +
              '<div class="grid grid-cols-3 gap-2">' +
                renderDifficultyBtn('easy', 'سهل', 'تطابق تقريبي') +
                renderDifficultyBtn('normal', 'عادي', 'تطابق معتدل') +
                renderDifficultyBtn('strict', 'صارم', 'تطابق دقيق') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      }

      function renderDifficultyBtn(level, label, desc) {
        const isActive = state.difficulty === level
        return '<button onclick="App.setDifficulty(&apos;' + level + '&apos;)" class="p-3 rounded-xl border-2 transition-all ' +
          (isActive ? 'border-quran-gold bg-quran-gold/10' : 'border-gray-200 dark:border-gray-600 hover:border-quran-gold/50') + '">' +
          '<p class="font-arabic font-bold text-sm ' + (isActive ? 'text-quran-gold' : 'text-gray-700 dark:text-gray-300') + '">' + label + '</p>' +
          '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">' + desc + '</p>' +
        '</button>'
      }

      // ==========================================
      // MUSHAF VIEW
      // ==========================================
      function renderMushaf() {
        return '<div class="min-h-screen flex flex-col">' +
          // Top bar
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700 flex-shrink-0">' +
            '<div class="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;home&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<div class="flex items-center gap-2">' +
                '<span class="font-arabic text-sm text-gray-600 dark:text-gray-400">صفحة</span>' +
                '<input type="number" id="page-input" value="' + state.currentPage + '" min="1" max="604" ' +
                  'class="w-16 text-center bg-gray-100 dark:bg-gray-700 rounded-lg px-2 py-1 text-sm font-bold text-gray-800 dark:text-white" ' +
                  'onchange="App.goToPage(this.value)" />' +
                '<span class="font-arabic text-xs text-gray-500 dark:text-gray-400">/ 604</span>' +
              '</div>' +
              '<div class="flex items-center gap-1">' +
                '<button onclick="App.toggleDarkMode()" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                  '<i class="fas ' + (state.darkMode ? 'fa-sun text-yellow-400' : 'fa-moon text-gray-600') + ' text-sm"></i>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</header>' +
          
          // Quran page
          '<div class="flex-1 flex flex-col items-center justify-start px-3 py-4 overflow-auto">' +
            (state.loading ? renderLoadingState() : (state.pageData ? renderQuranPage() : renderEmptyState())) +
          '</div>' +
          
          // Bottom controls
          '<div class="flex-shrink-0 bg-white dark:bg-gray-800 border-t border-gray-100 dark:border-gray-700 shadow-lg">' +
            '<div id="session-controls">' + renderBottomControlsInner() + '</div>' +
          '</div>' +
        '</div>'
      }

      function renderQuranPage() {
        if (!state.pageData || !state.pageData.verses) return '<p class="font-arabic text-gray-500">لا توجد بيانات</p>'
        
        const pageNum = state.currentPage
        const fontLoaded = QCFFontLoader.isFontLoaded(pageNum)
        const fontFamily = QCFFontLoader.getFontFamily(pageNum)
        
        // Group all tokens by line number
        const lineMap = new Map()
        let globalWordIndex = 0
        
        // Track which surahs start on this page (verse_number === 1)
        const surahStarts = new Set()
        // Track line numbers where surah headers should appear (line before the first verse of surah)
        const surahHeaderLines = new Map() // lineNum -> chapterId
        
        for (const verse of state.pageData.verses) {
          if (verse.verse_number === 1) {
            surahStarts.add(verse.chapter_id)
            // Find the first token's line
            if (verse.all_tokens.length > 0) {
              surahHeaderLines.set(verse.all_tokens[0].line_number, verse.chapter_id)
            }
          }
          
          for (const token of verse.all_tokens) {
            const line = token.line_number
            if (!lineMap.has(line)) lineMap.set(line, [])
            
            if (token.char_type_name === 'word') {
              lineMap.get(line).push({
                ...token,
                verse_key: verse.verse_key,
                globalIndex: globalWordIndex,
                isWord: true,
              })
              globalWordIndex++
            } else {
              // End marker (ayah number)
              lineMap.get(line).push({
                ...token,
                verse_key: verse.verse_key,
                isWord: false,
              })
            }
          }
        }
        
        const sortedLines = Array.from(lineMap.entries()).sort((a, b) => a[0] - b[0])
        
        // Get surah names for this page
        const chaptersOnPage = [...new Set(state.pageData.verses.map(v => v.chapter_id))]
        const surahNamesOnPage = chaptersOnPage.map(id => SURAH_NAMES[id] || ('سورة ' + id))
        
        let html = '<div class="quran-page rounded-xl p-3 sm:p-5 max-w-2xl w-full">'
        
        // Page top bar: Juz / Surah name / Page number
        html += '<div class="flex items-center justify-between px-2 pb-2 mb-1" style="border-bottom: 1px solid rgba(184,150,42,0.25);">'
        html += '<span class="font-arabic text-xs" style="color:#8b7d3c;">' + surahNamesOnPage[surahNamesOnPage.length - 1] + '</span>'
        html += '<span class="font-arabic text-xs" style="color:#8b7d3c;">' + pageNum + '</span>'
        html += '<span class="font-arabic text-xs" style="color:#8b7d3c;">' + surahNamesOnPage[0] + '</span>'
        html += '</div>'
        
        // Render lines
        for (const [lineNum, tokens] of sortedLines) {
          // Check if a surah header should appear before this line
          if (surahHeaderLines.has(lineNum)) {
            const chId = surahHeaderLines.get(lineNum)
            const surahName = SURAH_NAMES[chId] || ('سورة ' + chId)
            html += '<div class="mushaf-surah-header">'
            html += '<span class="font-arabic text-sm font-bold" style="color:#6b5c1f;">سورة ' + surahName + '</span>'
            html += '</div>'
            // Add Bismillah for all surahs except Al-Fatiha (1) and At-Tawbah (9)
            if (chId !== 1 && chId !== 9) {
              html += '<div class="mushaf-bismillah">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>'
            }
          }
          
          html += '<div class="quran-line">'
          
          for (const token of tokens) {
            if (token.isWord) {
              const isRevealed = !state.sessionActive || state.revealedWords.has(token.globalIndex)
              const isCurrent = state.sessionActive && token.globalIndex === state.currentWordIndex
              const attempts = state.wordAttempts[token.globalIndex?.toString()] 
              const hasError = attempts && attempts.count >= 2
              
              // Use QCF V2 rendering when font is loaded, otherwise fall back
              if (fontLoaded && token.code_v2) {
                html += '<span class="word-cell ' + 
                  (isCurrent ? 'current-word' : '') +
                  '" data-word-index="' + token.globalIndex + '" data-location="' + (token.location || '') + '">' +
                  '<span class="qcf-word qcf-p' + pageNum + ' ' + 
                    (state.sessionActive && !isRevealed ? 'word-hidden' : 'word-revealed') +
                    (hasError ? ' text-red-600 dark:text-red-400' : '') +
                  '" style="font-size:28px;">' + token.code_v2 + '</span>' +
                '</span>'
              } else {
                // Fallback: use UthmanicHafs with text_uthmani
                html += '<span class="word-cell ' + 
                  (isCurrent ? 'current-word' : '') +
                  '" data-word-index="' + token.globalIndex + '" data-location="' + (token.location || '') + '">' +
                  '<span class="qcf-word loading ' + 
                    (state.sessionActive && !isRevealed ? 'word-hidden' : 'word-revealed') +
                    (hasError ? ' text-red-600 dark:text-red-400' : '') +
                  '" style="font-size:26px;" data-page="' + pageNum + '" data-code-v2="' + encodeHTMLAttr(token.code_v2 || '') + '">' + 
                  (token.text_uthmani || '') + '</span>' +
                '</span>'
              }
            } else {
              // Ayah end marker - always use UthmanicHafs
              html += '<span class="ayah-marker" style="font-size:22px;">' +
                (token.text_qpc_hafs || token.text_uthmani || '') +
              '</span>'
            }
          }
          
          html += '</div>'
        }
        
        // Page footer
        html += '<div class="mushaf-page-footer">'
        html += '<span class="font-arabic text-xs" style="color:#8b7d3c;">' + pageNum + '</span>'
        html += '</div>'
        
        html += '</div>'
        
        // Page navigation arrows
        html += '<div class="flex items-center justify-between w-full max-w-2xl mt-4 px-2">'
        // RTL: Right arrow = previous (next in number), Left arrow = next (prev in number)
        html += '<button onclick="App.nextPage()" class="page-nav-btn p-3 rounded-full bg-white dark:bg-gray-800 shadow-md hover:shadow-lg border border-gray-200 dark:border-gray-600 ' + (state.currentPage <= 1 ? 'opacity-30 cursor-not-allowed' : '') + '" ' + (state.currentPage <= 1 ? 'disabled' : '') + '>' +
          '<i class="fas fa-chevron-left text-gray-600 dark:text-gray-400"></i></button>'
        html += '<span class="font-arabic text-sm text-gray-500 dark:text-gray-400">' + state.currentPage + ' / 604</span>'
        html += '<button onclick="App.prevPage()" class="page-nav-btn p-3 rounded-full bg-white dark:bg-gray-800 shadow-md hover:shadow-lg border border-gray-200 dark:border-gray-600 ' + (state.currentPage >= 604 ? 'opacity-30 cursor-not-allowed' : '') + '" ' + (state.currentPage >= 604 ? 'disabled' : '') + '>' +
          '<i class="fas fa-chevron-right text-gray-600 dark:text-gray-400"></i></button>'
        html += '</div>'
        
        return html
      }
      
      // Helper to safely encode HTML attribute values
      function encodeHTMLAttr(str) {
        if (!str) return ''
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }

      function renderBottomControlsInner() {
        const silenceTime = state.lastSpeechTime ? Math.floor((Date.now() - state.lastSpeechTime) / 1000) : 0
        
        if (!state.sessionActive) {
          return '<div class="max-w-4xl mx-auto px-4 py-3">' +
            '<button onclick="App.startSession()" class="w-full bg-gradient-to-r from-quran-gold to-yellow-600 hover:from-yellow-600 hover:to-yellow-700 text-white font-arabic font-bold py-4 px-6 rounded-xl transition-all shadow-lg hover:shadow-xl text-lg">' +
              '<i class="fas fa-microphone ml-2"></i>ابدأ التسميع' +
            '</button>' +
          '</div>'
        }
        
        let html = '<div class="max-w-4xl mx-auto px-4 py-3 space-y-3">'
        
        // Listening indicator & interim text
        if (!state.sessionPaused) {
          html += '<div class="flex items-center justify-center gap-3">'
          if (state.isListening) {
            html += '<div class="listening-indicator w-3 h-3 bg-red-500 rounded-full"></div>'
          } else if (state._isRestarting) {
            html += '<div class="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>'
          } else {
            html += '<div class="w-3 h-3 bg-gray-400 rounded-full"></div>'
          }
          html += '<span class="font-arabic text-sm text-gray-600 dark:text-gray-400">'
          if (!state.isListening && state._isRestarting) {
            html += 'إعادة الاتصال...'
          } else if (silenceTime >= 5 && silenceTime < 15) {
            html += 'جارٍ الاستماع...'
          } else if (silenceTime >= 15) {
            html += '<span class="text-red-500">صمت طويل - حاول مرة أخرى</span>'
          } else {
            html += 'يستمع...'
          }
          html += '</span>'
          html += '<span id="interim-text" class="font-arabic text-sm text-quran-gold max-w-xs truncate"></span>'
          html += '</div>'
        }
        
        // Session stats bar
        html += '<div class="flex items-center justify-between text-xs font-arabic text-gray-500 dark:text-gray-400">'
        html += '<span><i class="fas fa-check-circle text-green-500 ml-1"></i>' + state.sessionStats.correctWords + '/' + state.sessionStats.totalWords + '</span>'
        html += '<span><i class="fas fa-times-circle text-red-500 ml-1"></i>' + state.sessionStats.errors + ' أخطاء</span>'
        html += '<span>' + state.difficulty + '</span>'
        html += '</div>'
        
        // Progress bar
        const progress = state.sessionStats.totalWords > 0 ? (state.sessionStats.correctWords / state.sessionStats.totalWords * 100) : 0
        html += '<div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">'
        html += '<div class="bg-gradient-to-r from-quran-gold to-yellow-500 h-2 rounded-full transition-all duration-300" style="width:' + progress + '%"></div>'
        html += '</div>'
        
        // Control buttons
        html += '<div class="flex items-center gap-2">'
        
        // Pause/Resume
        if (state.sessionPaused) {
          html += '<button onclick="App.resumeSession()" class="flex-1 bg-green-500 hover:bg-green-600 text-white font-arabic font-bold py-3 px-4 rounded-xl transition-colors">' +
            '<i class="fas fa-play ml-1"></i>استمرار</button>'
        } else {
          html += '<button onclick="App.pauseSession()" class="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-arabic font-bold py-3 px-4 rounded-xl transition-colors">' +
            '<i class="fas fa-pause ml-1"></i>إيقاف مؤقت</button>'
        }
        
        // End session
        html += '<button onclick="App.endSession()" class="bg-red-500 hover:bg-red-600 text-white font-arabic font-bold py-3 px-4 rounded-xl transition-colors">' +
          '<i class="fas fa-stop ml-1"></i>إنهاء</button>'
        
        html += '</div>'
        
        // Manual assistance buttons
        html += '<div class="flex items-center gap-2">'
        html += '<button onclick="App.revealNextWord()" class="flex-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-arabic text-sm py-2.5 px-3 rounded-xl transition-colors">' +
          '<i class="fas fa-eye ml-1"></i>كشف كلمة</button>'
        html += '<button onclick="App.revealCurrentAyah()" class="flex-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-arabic text-sm py-2.5 px-3 rounded-xl transition-colors">' +
          '<i class="fas fa-eye ml-1"></i>كشف الآية</button>'
        html += '<button onclick="App.toggleDebugPanel()" class="bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-sm py-2.5 px-3 rounded-xl transition-colors" title="سجل التشخيص">' +
          '<i class="fas fa-bug"></i></button>'
        html += '</div>'
        
        // Debug panel
        if (state.showDebugPanel) {
          html += '<div class="bg-gray-900 rounded-xl p-3 max-h-48 overflow-y-auto" style="direction:rtl">'
          html += '<div class="flex items-center justify-between mb-2">'
          html += '<span class="text-xs text-gray-400 font-arabic font-bold">سجل التطابق (كلمة #' + state.currentWordIndex + ')</span>'
          html += '<button onclick="App.toggleDebugPanel()" class="text-gray-500 hover:text-gray-300 text-xs">✕</button>'
          html += '</div>'
          html += '<div id="debug-panel-content">'
          // Render existing log entries
          for (const entry of state.debugLog) {
            const colors = {
              'heard': 'text-blue-400',
              'match': 'text-green-400',
              'no-match': 'text-red-400',
              'interim-match': 'text-cyan-400',
              're-read': 'text-yellow-400',
              'skip-match': 'text-purple-400',
              'alt': 'text-orange-400',
              'system': 'text-gray-400',
            }
            const color = colors[entry.type] || 'text-gray-300'
            const typeLabel = {
              'heard': '🔊 سمع',
              'match': '✅ طابق',
              'no-match': '❌ لم يطابق',
              'interim-match': '⚡ مؤقت',
              're-read': '🔁 إعادة',
              'skip-match': '⏭️ تخطي',
              'alt': '🔄 بديل',
              'system': '⚙️ نظام',
            }
            html += '<div class=\"text-xs font-mono leading-5 border-b border-gray-700 py-1\">'
            html += '<span class=\"text-gray-500\">' + entry.time + '</span> '
            html += '<span class=\"' + color + ' font-bold\">[' + (typeLabel[entry.type] || entry.type) + ']</span> '
            html += '<span class=\"text-white font-arabic\">' + entry.spoken + '</span>'
            if (entry.detail) {
              html += '<br><span class=\"text-gray-400 mr-4 font-arabic\">' + entry.detail + '</span>'
            }
            html += '</div>'
          }
          if (state.debugLog.length === 0) {
            html += '<div class=\"text-gray-500 text-center py-4 font-arabic\">ابدأ التسميع لرؤية سجل المطابقة</div>'
          }
          html += '</div>'
          html += '</div>'
        }
        
        html += '</div>'
        return html
      }

      function renderLoadingState() {
        return '<div class="flex flex-col items-center justify-center py-20">' +
          '<div class="breathe"><i class="fas fa-spinner fa-spin text-4xl text-quran-gold"></i></div>' +
          '<p class="font-arabic text-gray-500 dark:text-gray-400 mt-4">جارٍ تحميل الصفحة...</p>' +
        '</div>'
      }

      function renderEmptyState() {
        return '<div class="flex flex-col items-center justify-center py-20">' +
          '<i class="fas fa-book-open text-5xl text-gray-300 dark:text-gray-600 mb-4"></i>' +
          '<p class="font-arabic text-gray-500 dark:text-gray-400">جارٍ تحميل المصحف...</p>' +
        '</div>'
      }

      // ==========================================
      // SESSION RESULTS VIEW
      // ==========================================
      function renderResults() {
        const s = sessionResultsData
        if (!s) return renderHome()
        
        const accuracy = getAccuracy(s)
        const accuracyColor = accuracy > 80 ? 'text-green-500' : accuracy > 50 ? 'text-yellow-500' : 'text-red-500'
        
        return '<div class="min-h-screen bg-gray-50 dark:bg-gray-900">' +
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;mushaf&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<h2 class="font-arabic font-bold text-gray-800 dark:text-white">نتائج الجلسة</h2>' +
              '<div></div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-6 space-y-6">' +
            // Score circle
            '<div class="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center shadow-sm">' +
              '<div class="w-32 h-32 rounded-full border-8 ' + (accuracy > 80 ? 'border-green-500' : accuracy > 50 ? 'border-yellow-500' : 'border-red-500') + ' flex items-center justify-center mx-auto mb-4">' +
                '<span class="text-4xl font-bold ' + accuracyColor + '">' + accuracy + '%</span>' +
              '</div>' +
              '<p class="font-arabic text-lg text-gray-700 dark:text-gray-300">' + 
                (accuracy > 80 ? 'ممتاز! أحسنت' : accuracy > 50 ? 'جيد، استمر في المراجعة' : 'تحتاج لمزيد من المراجعة') + 
              '</p>' +
            '</div>' +
            
            // Stats grid
            '<div class="grid grid-cols-2 gap-4">' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400 mb-1">الكلمات الصحيحة</p>' +
                '<p class="text-2xl font-bold text-green-500">' + s.correct_words + '<span class="text-sm text-gray-400">/' + s.total_words + '</span></p>' +
              '</div>' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400 mb-1">الأخطاء</p>' +
                '<p class="text-2xl font-bold text-red-500">' + s.errors_count + '</p>' +
              '</div>' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400 mb-1">المدة</p>' +
                '<p class="text-2xl font-bold text-blue-500">' + formatDuration(s.duration_seconds) + '</p>' +
              '</div>' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400 mb-1">المستوى</p>' +
                '<p class="text-xl font-bold text-quran-gold font-arabic">' + getDifficultyLabel(s.difficulty) + '</p>' +
              '</div>' +
            '</div>' +
            
            // Error details
            (s.error_details && s.error_details.length > 0 ? 
              '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
                '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-4"><i class="fas fa-exclamation-triangle text-red-500 ml-2"></i>تفاصيل الأخطاء</h3>' +
                '<div class="space-y-3 max-h-64 overflow-auto">' +
                s.error_details.map(err => 
                  '<div class="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                    '<div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ' + getErrorTypeColor(err.error_type) + '">' +
                      '<i class="fas ' + getErrorTypeIcon(err.error_type) + ' text-white text-xs"></i>' +
                    '</div>' +
                    '<div class="flex-1 min-w-0">' +
                      '<div class="flex items-center gap-2 mb-1">' +
                        '<span class="font-quran text-lg text-gray-800 dark:text-white">' + err.expected_text + '</span>' +
                        '<span class="font-arabic text-xs px-2 py-0.5 rounded-full ' + getErrorTypeBadge(err.error_type) + '">' + getErrorTypeLabel(err.error_type) + '</span>' +
                      '</div>' +
                      (err.recognized_text ? '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">ما تم سماعه: <span class="text-red-500">' + err.recognized_text + '</span></p>' : '') +
                      '<p class="font-arabic text-xs text-gray-400">الموقع: ' + err.word_location + ' | المحاولات: ' + err.attempts + '</p>' +
                    '</div>' +
                  '</div>'
                ).join('') +
                '</div>' +
              '</div>'
            : '<div class="bg-green-50 dark:bg-green-900/20 rounded-2xl p-5 text-center"><p class="font-arabic text-green-600 dark:text-green-400"><i class="fas fa-check-circle ml-2"></i>لا توجد أخطاء! ما شاء الله</p></div>') +
            
            // Action buttons
            '<div class="flex gap-3">' +
              '<button onclick="App.navigate(&apos;mushaf&apos;)" class="flex-1 bg-quran-gold hover:bg-yellow-600 text-white font-arabic font-bold py-3 rounded-xl transition-colors">تسميع مرة أخرى</button>' +
              '<button onclick="App.navigate(&apos;home&apos;)" class="flex-1 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-arabic font-bold py-3 rounded-xl transition-colors">الرئيسية</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      }

      // ==========================================
      // ANALYTICS VIEW
      // ==========================================
      function renderAnalytics() {
        const sessions = state.sessionHistory
        
        return '<div class="min-h-screen bg-gray-50 dark:bg-gray-900">' +
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;home&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<h2 class="font-arabic font-bold text-gray-800 dark:text-white">الإحصائيات</h2>' +
              '<div></div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-6 space-y-6">' +
            // Overall stats
            '<div class="grid grid-cols-2 gap-4">' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm text-center">' +
                '<i class="fas fa-chart-line text-quran-gold text-2xl mb-2"></i>' +
                '<p class="text-2xl font-bold text-gray-800 dark:text-white">' + getOverallAccuracy() + '%</p>' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">متوسط الدقة</p>' +
              '</div>' +
              '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm text-center">' +
                '<i class="fas fa-clock text-blue-500 text-2xl mb-2"></i>' +
                '<p class="text-2xl font-bold text-gray-800 dark:text-white">' + getTotalTime() + '</p>' +
                '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">إجمالي الوقت</p>' +
              '</div>' +
            '</div>' +
            
            // Error rate
            '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
              '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-3">معدل الأخطاء</h3>' +
              '<div class="flex items-center gap-3">' +
                '<div class="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-4">' +
                  '<div class="bg-gradient-to-r from-green-500 to-red-500 h-4 rounded-full" style="width:' + getErrorRate() + '%"></div>' +
                '</div>' +
                '<span class="text-sm font-bold text-gray-600 dark:text-gray-400">' + getErrorRate() + '%</span>' +
              '</div>' +
              '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400 mt-2">لكل 100 كلمة</p>' +
            '</div>' +
            
            // Session history
            '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
              '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-4">سجل الجلسات</h3>' +
              (sessions.length === 0 ? 
                '<p class="font-arabic text-center text-gray-400 py-8">لا توجد جلسات بعد</p>' :
                '<div class="space-y-3 max-h-96 overflow-auto">' +
                sessions.map((s, i) => 
                  '<button onclick="App.viewSessionDetail(' + i + ')" class="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600/50 transition-colors text-right">' +
                    '<div class="flex items-center gap-3 flex-1 min-w-0">' +
                      '<div class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ' + (getAccuracy(s) > 80 ? 'bg-green-100 dark:bg-green-900/30' : getAccuracy(s) > 50 ? 'bg-yellow-100 dark:bg-yellow-900/30' : 'bg-red-100 dark:bg-red-900/30') + '">' +
                        '<span class="text-sm font-bold ' + (getAccuracy(s) > 80 ? 'text-green-600 dark:text-green-400' : getAccuracy(s) > 50 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400') + '">' + getAccuracy(s) + '%</span>' +
                      '</div>' +
                      '<div class="flex-1 min-w-0">' +
                        '<p class="font-arabic text-sm text-gray-700 dark:text-gray-300">صفحة ' + s.scope_value + ' <span class="text-xs text-gray-400">(' + getDifficultyLabel(s.difficulty) + ')</span></p>' +
                        '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">' + formatDate(s.start_time) + ' - ' + formatDuration(s.duration_seconds) + '</p>' +
                      '</div>' +
                    '</div>' +
                    '<div class="flex items-center gap-2 flex-shrink-0">' +
                      '<div class="text-left">' +
                        '<p class="text-xs text-gray-500 dark:text-gray-400">' + s.correct_words + '/' + s.total_words + '</p>' +
                        (s.errors_count > 0 ? '<p class="text-xs text-red-500">' + s.errors_count + ' خطأ</p>' : '<p class="text-xs text-green-500">بدون أخطاء</p>') +
                      '</div>' +
                      '<i class="fas fa-chevron-left text-gray-400 text-xs"></i>' +
                    '</div>' +
                  '</button>'
                ).join('') +
                '</div>'
              ) +
            '</div>' +
            
            // Most problematic words
            (getMostProblematicWords().length > 0 ?
              '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
                '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-4"><i class="fas fa-exclamation-circle text-red-500 ml-2"></i>أكثر الكلمات إشكالية</h3>' +
                '<div class="flex flex-wrap gap-2">' +
                getMostProblematicWords().map(w =>
                  '<span class="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 px-3 py-1.5 rounded-lg font-quran text-lg">' + w.text + ' <span class="text-xs">(' + w.count + ')</span></span>'
                ).join('') +
                '</div>' +
              '</div>'
            : '') +
          '</div>' +
        '</div>'
      }

      // ==========================================
      // SESSION DETAIL VIEW
      // ==========================================
      function viewSessionDetail(index) {
        state.selectedSession = state.sessionHistory[index]
        state.currentView = 'session-detail'
        render()
      }

      function renderSessionDetail() {
        const s = state.selectedSession
        if (!s) return renderAnalytics()
        
        const accuracy = getAccuracy(s)
        const accuracyColor = accuracy > 80 ? 'text-green-500' : accuracy > 50 ? 'text-yellow-500' : 'text-red-500'
        const errors = s.error_details || []
        
        // Group errors by type
        const errorsByType = {}
        errors.forEach(err => {
          const t = err.error_type || 'other'
          if (!errorsByType[t]) errorsByType[t] = []
          errorsByType[t].push(err)
        })
        
        // Group errors by ayah
        const errorsByAyah = {}
        errors.forEach(err => {
          const loc = err.word_location || ''
          const ayahKey = loc.split(':').slice(0, 2).join(':')
          if (!errorsByAyah[ayahKey]) errorsByAyah[ayahKey] = []
          errorsByAyah[ayahKey].push(err)
        })
        
        return '<div class="min-h-screen bg-gray-50 dark:bg-gray-900">' +
          // Header
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;analytics&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<h2 class="font-arabic font-bold text-gray-800 dark:text-white">تفاصيل الجلسة</h2>' +
              '<div></div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-6 space-y-5">' +
            
            // Session summary card
            '<div class="bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-sm">' +
              '<div class="flex items-center justify-between mb-4">' +
                '<div>' +
                  '<h3 class="font-arabic font-bold text-lg text-gray-800 dark:text-white">صفحة ' + s.scope_value + '</h3>' +
                  '<p class="font-arabic text-sm text-gray-500 dark:text-gray-400">' + formatDate(s.start_time) + '</p>' +
                '</div>' +
                '<div class="w-16 h-16 rounded-full border-4 ' + (accuracy > 80 ? 'border-green-500' : accuracy > 50 ? 'border-yellow-500' : 'border-red-500') + ' flex items-center justify-center">' +
                  '<span class="text-xl font-bold ' + accuracyColor + '">' + accuracy + '%</span>' +
                '</div>' +
              '</div>' +
              
              // Stats row
              '<div class="grid grid-cols-4 gap-3">' +
                '<div class="text-center p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                  '<p class="text-lg font-bold text-green-500">' + s.correct_words + '</p>' +
                  '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">صحيح</p>' +
                '</div>' +
                '<div class="text-center p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                  '<p class="text-lg font-bold text-gray-600 dark:text-gray-300">' + s.total_words + '</p>' +
                  '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">إجمالي</p>' +
                '</div>' +
                '<div class="text-center p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                  '<p class="text-lg font-bold text-red-500">' + s.errors_count + '</p>' +
                  '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">أخطاء</p>' +
                '</div>' +
                '<div class="text-center p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg">' +
                  '<p class="text-lg font-bold text-blue-500">' + formatDuration(s.duration_seconds) + '</p>' +
                  '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">المدة</p>' +
                '</div>' +
              '</div>' +
              
              // Difficulty & mode
              '<div class="flex gap-2 mt-3">' +
                '<span class="font-arabic text-xs px-3 py-1 rounded-full bg-quran-gold/10 text-quran-gold">' + getDifficultyLabel(s.difficulty) + '</span>' +
                '<span class="font-arabic text-xs px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">صفحة ' + s.scope_value + '</span>' +
              '</div>' +
            '</div>' +
            
            // Error summary by type
            (errors.length > 0 ?
              '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
                '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-4"><i class="fas fa-chart-pie text-quran-gold ml-2"></i>ملخص الأخطاء حسب النوع</h3>' +
                '<div class="grid grid-cols-2 gap-3">' +
                  (errorsByType['forget'] ? 
                    '<div class="flex items-center gap-2 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg">' +
                      '<div class="w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center"><i class="fas fa-brain text-white text-xs"></i></div>' +
                      '<div><p class="font-arabic text-sm font-bold text-purple-700 dark:text-purple-400">نسيان</p><p class="text-xs text-purple-600 dark:text-purple-300">' + errorsByType['forget'].length + ' كلمة</p></div>' +
                    '</div>' : '') +
                  (errorsByType['substitution'] ? 
                    '<div class="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">' +
                      '<div class="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center"><i class="fas fa-exchange-alt text-white text-xs"></i></div>' +
                      '<div><p class="font-arabic text-sm font-bold text-red-700 dark:text-red-400">إبدال</p><p class="text-xs text-red-600 dark:text-red-300">' + errorsByType['substitution'].length + ' كلمة</p></div>' +
                    '</div>' : '') +
                  (errorsByType['order'] ? 
                    '<div class="flex items-center gap-2 p-3 bg-orange-50 dark:bg-orange-900/20 rounded-lg">' +
                      '<div class="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center"><i class="fas fa-sort text-white text-xs"></i></div>' +
                      '<div><p class="font-arabic text-sm font-bold text-orange-700 dark:text-orange-400">ترتيب</p><p class="text-xs text-orange-600 dark:text-orange-300">' + errorsByType['order'].length + ' كلمة</p></div>' +
                    '</div>' : '') +
                  (errorsByType['pronunciation'] ? 
                    '<div class="flex items-center gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">' +
                      '<div class="w-8 h-8 bg-yellow-500 rounded-full flex items-center justify-center"><i class="fas fa-volume-up text-white text-xs"></i></div>' +
                      '<div><p class="font-arabic text-sm font-bold text-yellow-700 dark:text-yellow-400">نطق</p><p class="text-xs text-yellow-600 dark:text-yellow-300">' + errorsByType['pronunciation'].length + ' كلمة</p></div>' +
                    '</div>' : '') +
                '</div>' +
              '</div>'
            : '') +
            
            // Detailed errors list grouped by ayah
            (errors.length > 0 ?
              '<div class="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">' +
                '<h3 class="font-arabic font-bold text-gray-800 dark:text-white mb-4"><i class="fas fa-list-ol text-red-500 ml-2"></i>تفاصيل الأخطاء</h3>' +
                '<div class="space-y-4">' +
                renderGroupedErrors(errorsByAyah) +
                '</div>' +
              '</div>'
            : '<div class="bg-green-50 dark:bg-green-900/20 rounded-2xl p-8 text-center">' +
                '<i class="fas fa-check-circle text-green-500 text-4xl mb-3"></i>' +
                '<p class="font-arabic text-lg text-green-600 dark:text-green-400 font-bold">ما شاء الله! لا توجد أخطاء</p>' +
                '<p class="font-arabic text-sm text-green-500 dark:text-green-400 mt-1">أداء ممتاز في هذه الجلسة</p>' +
              '</div>') +
            
            // Action buttons
            '<div class="flex gap-3">' +
              '<button onclick="App.navigate(&apos;analytics&apos;)" class="flex-1 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 font-arabic font-bold py-3 rounded-xl transition-colors">' +
                '<i class="fas fa-arrow-right ml-1"></i>الرجوع' +
              '</button>' +
              '<button onclick="App.goToPageFromDetail(' + s.scope_value + ')" class="flex-1 bg-quran-gold hover:bg-yellow-600 text-white font-arabic font-bold py-3 rounded-xl transition-colors">' +
                '<i class="fas fa-redo ml-1"></i>إعادة تسميع الصفحة' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      }

      // ==========================================
      // SETTINGS VIEW
      // ==========================================
      function renderSettings() {
        return '<div class="min-h-screen bg-gray-50 dark:bg-gray-900">' +
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;home&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<h2 class="font-arabic font-bold text-gray-800 dark:text-white">الإعدادات</h2>' +
              '<div></div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-6 space-y-4">' +
            // Dark mode
            '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 flex items-center justify-between shadow-sm">' +
              '<div class="flex items-center gap-3">' +
                '<i class="fas fa-moon text-quran-gold"></i>' +
                '<span class="font-arabic text-gray-700 dark:text-gray-300">الوضع الليلي</span>' +
              '</div>' +
              '<button onclick="App.toggleDarkMode()" class="w-12 h-6 rounded-full ' + (state.darkMode ? 'bg-quran-gold' : 'bg-gray-300') + ' relative transition-colors">' +
                '<div class="w-5 h-5 bg-white rounded-full absolute top-0.5 transition-all ' + (state.darkMode ? 'right-0.5' : 'left-0.5') + '"></div>' +
              '</button>' +
            '</div>' +
            
            // Difficulty
            '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
              '<div class="flex items-center gap-3 mb-3">' +
                '<i class="fas fa-sliders text-quran-gold"></i>' +
                '<span class="font-arabic text-gray-700 dark:text-gray-300 font-bold">مستوى الصعوبة</span>' +
              '</div>' +
              '<div class="space-y-2">' +
                renderSettingsDifficultyOption('easy', 'سهل', 'مسافة ≤30% | ثقة ≥60%') +
                renderSettingsDifficultyOption('normal', 'عادي', 'مسافة ≤20% | ثقة ≥75%') +
                renderSettingsDifficultyOption('strict', 'صارم', 'مسافة ≤10% | ثقة ≥85%') +
              '</div>' +
            '</div>' +
            
            // Clear data
            '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm">' +
              '<div class="flex items-center gap-3 mb-3">' +
                '<i class="fas fa-trash text-red-500"></i>' +
                '<span class="font-arabic text-gray-700 dark:text-gray-300 font-bold">إدارة البيانات</span>' +
              '</div>' +
              '<button onclick="App.clearHistory()" class="w-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 font-arabic py-2.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors">' +
                'مسح سجل الجلسات' +
              '</button>' +
            '</div>' +
            
            // Show onboarding
            '<button onclick="App.showOnboarding()" class="w-full bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm text-right">' +
              '<div class="flex items-center gap-3">' +
                '<i class="fas fa-info-circle text-blue-500"></i>' +
                '<span class="font-arabic text-gray-700 dark:text-gray-300">عرض الشرح التعريفي</span>' +
              '</div>' +
            '</button>' +
            
            // About
            '<div class="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm text-center">' +
              '<p class="font-arabic text-sm text-gray-500 dark:text-gray-400">تسميع القرآن - Quran Tasmee3</p>' +
              '<p class="text-xs text-gray-400 mt-1">v1.0.0 | Built with Hono + Cloudflare Workers</p>' +
              '<p class="font-arabic text-xs text-gray-400 mt-1">بيانات القرآن من quran.com API</p>' +
            '</div>' +
          '</div>' +
        '</div>'
      }

      function renderSettingsDifficultyOption(level, label, desc) {
        const isActive = state.difficulty === level
        return '<button onclick="App.setDifficulty(&apos;' + level + '&apos;)" class="w-full flex items-center justify-between p-3 rounded-lg border ' +
          (isActive ? 'border-quran-gold bg-quran-gold/5' : 'border-gray-200 dark:border-gray-600') + ' transition-all">' +
          '<div><span class="font-arabic font-bold text-sm ' + (isActive ? 'text-quran-gold' : 'text-gray-700 dark:text-gray-300') + '">' + label + '</span>' +
          '<span class="font-arabic text-xs text-gray-500 dark:text-gray-400 block">' + desc + '</span></div>' +
          (isActive ? '<i class="fas fa-check-circle text-quran-gold"></i>' : '') +
        '</button>'
      }

      // ==========================================
      // SURAH LIST VIEW
      // ==========================================
      function renderSurahList() {
        return '<div class="min-h-screen bg-gray-50 dark:bg-gray-900">' +
          '<header class="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-100 dark:border-gray-700">' +
            '<div class="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">' +
              '<button onclick="App.navigate(&apos;home&apos;)" class="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">' +
                '<i class="fas fa-arrow-right text-gray-600 dark:text-gray-400"></i>' +
              '</button>' +
              '<h2 class="font-arabic font-bold text-gray-800 dark:text-white">فهرس السور</h2>' +
              '<div></div>' +
            '</div>' +
          '</header>' +
          
          '<div class="max-w-4xl mx-auto px-4 py-4">' +
            (state.surahs ? 
              '<div class="space-y-2">' +
              state.surahs.map(s =>
                '<button onclick="App.goToSurah(' + s.id + ')" class="w-full flex items-center justify-between p-3 bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-md transition-all border border-gray-100 dark:border-gray-700">' +
                  '<div class="flex items-center gap-3">' +
                    '<div class="w-10 h-10 bg-quran-gold/10 rounded-lg flex items-center justify-center">' +
                      '<span class="text-quran-gold font-bold text-sm">' + s.id + '</span>' +
                    '</div>' +
                    '<div class="text-right">' +
                      '<p class="font-arabic font-bold text-gray-800 dark:text-white">' + s.name_arabic + '</p>' +
                      '<p class="text-xs text-gray-500 dark:text-gray-400">' + s.name_simple + ' - ' + s.verses_count + ' آية</p>' +
                    '</div>' +
                  '</div>' +
                  '<div class="text-left">' +
                    '<p class="font-arabic text-xs text-gray-500 dark:text-gray-400">ص ' + (s.pages?.[0] || '-') + '</p>' +
                  '</div>' +
                '</button>'
              ).join('') +
              '</div>'
            : '<div class="text-center py-20"><div class="breathe"><i class="fas fa-spinner fa-spin text-3xl text-quran-gold"></i></div><p class="font-arabic text-gray-500 mt-4">جارٍ تحميل فهرس السور...</p></div>') +
          '</div>' +
        '</div>'
      }

      // ==========================================
      // UTILITY FUNCTIONS
      // ==========================================
      function formatDate(dateStr) {
        if (!dateStr) return ''
        const d = new Date(dateStr)
        return d.toLocaleDateString('ar-SA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      }

      function formatDuration(seconds) {
        if (!seconds) return '0:00'
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        return m + ':' + (s < 10 ? '0' : '') + s
      }

      function getAccuracy(session) {
        if (!session || session.total_words === 0) return 0
        return Math.round(session.correct_words / session.total_words * 100)
      }

      function getTotalCorrectWords() {
        return state.sessionHistory.reduce((sum, s) => sum + (s.correct_words || 0), 0)
      }

      function getUniquePagesCount() {
        return new Set(state.sessionHistory.map(s => s.scope_value)).size
      }

      function getOverallAccuracy() {
        if (state.sessionHistory.length === 0) return 0
        const totalCorrect = state.sessionHistory.reduce((sum, s) => sum + (s.correct_words || 0), 0)
        const totalWords = state.sessionHistory.reduce((sum, s) => sum + (s.total_words || 0), 0)
        return totalWords > 0 ? Math.round(totalCorrect / totalWords * 100) : 0
      }

      function getTotalTime() {
        const totalSec = state.sessionHistory.reduce((sum, s) => sum + (s.duration_seconds || 0), 0)
        const hours = Math.floor(totalSec / 3600)
        const mins = Math.floor((totalSec % 3600) / 60)
        if (hours > 0) return hours + 'h ' + mins + 'm'
        return mins + 'm'
      }

      function getErrorRate() {
        const totalWords = state.sessionHistory.reduce((sum, s) => sum + (s.total_words || 0), 0)
        const totalErrors = state.sessionHistory.reduce((sum, s) => sum + (s.errors_count || 0), 0)
        if (totalWords === 0) return 0
        return Math.round(totalErrors / totalWords * 100)
      }

      function getMostProblematicWords() {
        const wordCounts = {}
        for (const session of state.sessionHistory) {
          if (session.error_details) {
            for (const err of session.error_details) {
              const key = err.expected_text
              if (!wordCounts[key]) wordCounts[key] = { text: key, count: 0 }
              wordCounts[key].count++
            }
          }
        }
        return Object.values(wordCounts).sort((a, b) => b.count - a.count).slice(0, 10)
      }

      function getDifficultyLabel(level) {
        return { easy: 'سهل', normal: 'عادي', strict: 'صارم' }[level] || level
      }

      function getErrorTypeLabel(type) {
        return { forget: 'نسيان', substitution: 'إبدال', order: 'ترتيب', pronunciation: 'نطق' }[type] || type
      }

      function getErrorTypeIcon(type) {
        return { forget: 'fa-brain', substitution: 'fa-exchange-alt', order: 'fa-sort', pronunciation: 'fa-volume-up' }[type] || 'fa-exclamation'
      }

      function getErrorTypeColor(type) {
        return { forget: 'bg-purple-500', substitution: 'bg-red-500', order: 'bg-orange-500', pronunciation: 'bg-yellow-500' }[type] || 'bg-gray-500'
      }

      function getErrorTypeBadge(type) {
        return { 
          forget: 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400',
          substitution: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
          order: 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400',
          pronunciation: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
        }[type] || 'bg-gray-100 text-gray-700'
      }

      // Render error rows grouped by ayah for session detail
      function renderGroupedErrors(errorsByAyah) {
        var html = ''
        var keys = Object.keys(errorsByAyah)
        for (var k = 0; k < keys.length; k++) {
          var ayahKey = keys[k]
          var ayahErrors = errorsByAyah[ayahKey]
          html += '<div class="border border-gray-200 dark:border-gray-600 rounded-xl overflow-hidden">'
          html += '<div class="bg-gray-50 dark:bg-gray-700/50 px-4 py-2 flex items-center justify-between">'
          html += '<span class="font-arabic text-sm font-bold text-gray-700 dark:text-gray-300"><i class="fas fa-bookmark text-quran-gold ml-1"></i>الآية ' + ayahKey + '</span>'
          html += '<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">' + ayahErrors.length + ' خطأ</span>'
          html += '</div>'
          html += '<div class="divide-y divide-gray-100 dark:divide-gray-700">'
          for (var e = 0; e < ayahErrors.length; e++) {
            html += renderSingleError(ayahErrors[e])
          }
          html += '</div></div>'
        }
        return html
      }

      function renderSingleError(err) {
        var h = '<div class="px-4 py-3"><div class="flex items-start gap-3">'
        h += '<div class="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-1 ' + getErrorTypeColor(err.error_type) + '">'
        h += '<i class="fas ' + getErrorTypeIcon(err.error_type) + ' text-white" style="font-size:10px"></i></div>'
        h += '<div class="flex-1 min-w-0">'
        h += '<div class="flex items-center gap-2 mb-1">'
        h += '<span class="font-quran text-xl text-gray-800 dark:text-white">' + err.expected_text + '</span>'
        h += '<span class="font-arabic text-xs px-2 py-0.5 rounded-full ' + getErrorTypeBadge(err.error_type) + '">' + getErrorTypeLabel(err.error_type) + '</span>'
        h += '</div>'
        if (err.recognized_text) {
          h += '<div class="flex items-center gap-1 mb-1"><span class="font-arabic text-xs text-gray-500 dark:text-gray-400">سُمع:</span>'
          h += '<span class="font-quran text-base text-red-500 dark:text-red-400">' + err.recognized_text + '</span></div>'
        } else {
          h += '<p class="font-arabic text-xs text-gray-400 mb-1">لم يُسمع شيء</p>'
        }
        h += '<div class="flex items-center gap-3 text-xs text-gray-400">'
        h += '<span><i class="fas fa-map-marker-alt ml-1"></i>' + (err.word_location || '') + '</span>'
        h += '<span><i class="fas fa-redo ml-1"></i>' + err.attempts + ' محاولة</span>'
        h += '<span><i class="fas fa-layer-group ml-1"></i>سطر ' + (err.line_number || '-') + '</span>'
        if (err.severity === 'manual_reveal') {
          h += '<span class="text-purple-500"><i class="fas fa-eye ml-1"></i>كشف يدوي</span>'
        }
        h += '</div></div></div></div>'
        return h
      }

      // ==========================================
      // NAVIGATION
      // ==========================================
      function navigate(view) {
        // End session if navigating away from mushaf
        if (state.sessionActive && view !== 'mushaf') {
          endSession()
        }
        
        state.currentView = view
        
        if (view === 'mushaf' && !state.pageData) {
          loadPage(state.currentPage)
        }
        
        if (view === 'surah-list') {
          loadSurahs()
        }
        
        render()
      }

      function goToPage(pageNum) {
        const num = parseInt(pageNum)
        if (isNaN(num) || num < 1 || num > 604) return
        
        if (state.sessionActive) {
          endSession()
        }
        
        loadPage(num)
      }

      function prevPage() {
        if (state.currentPage >= 604) return
        goToPage(state.currentPage + 1)
      }

      function nextPage() {
        if (state.currentPage <= 1) return
        goToPage(state.currentPage - 1)
      }

      function goToSurah(surahId) {
        // Find the page for this surah
        const surah = state.surahs?.find(s => s.id === surahId)
        if (surah && surah.pages) {
          state.currentView = 'mushaf'
          goToPage(surah.pages[0])
        }
      }

      function clearHistory() {
        if (confirm('هل أنت متأكد من مسح جميع الجلسات؟')) {
          state.sessionHistory = []
          localStorage.setItem('sessionHistory', '[]')
          showToast('تم مسح السجل', 'success')
          render()
        }
      }

      function goToPageFromDetail(pageNum) {
        state.currentView = 'mushaf'
        goToPage(parseInt(pageNum))
      }

      function showOnboardingAgain() {
        state.showOnboarding = true
        render()
      }

      // ==========================================
      // EVENT BINDING
      // ==========================================
      function bindEvents() {
        // Page input enter key
        const pageInput = document.getElementById('page-input')
        if (pageInput) {
          pageInput.onkeydown = (e) => {
            if (e.key === 'Enter') goToPage(pageInput.value)
          }
        }
      }

      // ==========================================
      // INITIALIZATION
      // ==========================================
      function init() {
        // Apply saved dark mode
        document.documentElement.classList.toggle('dark', state.darkMode)
        
        // Initial render
        render()
      }

      // Public API
      return {
        init,
        navigate,
        goToPage,
        prevPage,
        nextPage,
        goToSurah,
        startSession,
        pauseSession,
        resumeSession,
        endSession,
        revealNextWord,
        revealCurrentAyah,
        toggleDebugPanel,
        toggleDarkMode,
        setDifficulty,
        completeOnboarding,
        clearHistory,
        showOnboarding: showOnboardingAgain,
        viewSessionDetail,
        goToPageFromDetail,
      }
    })()

    // Boot
    document.addEventListener('DOMContentLoaded', App.init)
    </script>
</body>
</html>`)
})

export default app

/* TEST */
// Comprehensive test block for Ottoman/Imlaei matching + all previous scenarios
// Run via standalone test script (not from built output since Vite tree-shakes it)
export function runTests() {
  // Updated ArabicNormalizerTest with Ottoman normalization
  const ArabicNormalizerTest = {
    normalizeOttoman(text: string) {
      return text
        .replace(/\u0670/g, '')  // Dagger alef → remove (diacritical mark)
        .replace(/\u06DF/g, '')
        .replace(/\u0653/g, '')
        .replace(/\u0654/g, '')
        .replace(/\u0655/g, '')
        .replace(/\u0656/g, '')
        .replace(/\u06E5/g, '')
        .replace(/\u06E6/g, '')
        // Quran pause/stop marks (U+06D6-U+06DC) + surrounding whitespace → remove
        .replace(/\s*[\u06D6-\u06DC]\s*/g, '')
        .replace(/\u0621\u0627/g, '\u0622')
    },
    removeDiacritics(text: string) {
      return text.replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06E0-\u06E8\u06EA-\u06ED\u08D4-\u08E1\u08D4-\u08ED\u08F0-\u08F3]/g, '')
    },
    normalizeAlif(text: string) {
      return text.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    },
    normalizeYa(text: string) {
      return text.replace(/\u0649/g, '\u064a')
    },
    normalizeTaMarbuta(text: string) {
      return text.replace(/\u0629/g, '\u0647')
    },
    removeTatweel(text: string) {
      return text.replace(/\u0640/g, '')
    },
    normalize(text: string, level = 'normal') {
      if (!text) return ''
      let normalized = text.trim()
      normalized = this.normalizeOttoman(normalized)
      normalized = this.removeTatweel(normalized)
      normalized = normalized.replace(/\s+/g, ' ').trim()
      if (level === 'strict') {
        normalized = this.normalizeAlif(normalized)
        return normalized
      }
      normalized = this.removeDiacritics(normalized)
      normalized = normalized.trim()
      normalized = this.normalizeAlif(normalized)
      normalized = this.normalizeYa(normalized)
      if (level === 'easy') {
        normalized = this.normalizeTaMarbuta(normalized)
      }
      return normalized
    }
  }

  const WordMatcherTest = {
    levenshteinDistance(a: string, b: string) {
      const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null))
      for (let i = 0; i <= a.length; i++) matrix[0][i] = i
      for (let j = 0; j <= b.length; j++) matrix[j][0] = j
      for (let j = 1; j <= b.length; j++) {
        for (let i = 1; i <= a.length; i++) {
          const cost = a[i-1] === b[j-1] ? 0 : 1
          matrix[j][i] = Math.min(matrix[j][i-1] + 1, matrix[j-1][i] + 1, matrix[j-1][i-1] + cost)
        }
      }
      return matrix[b.length][a.length]
    },
    similarity(a: string, b: string) {
      if (!a || !b) return 0
      const maxLen = Math.max(a.length, b.length)
      if (maxLen === 0) return 1
      return 1 - (this.levenshteinDistance(a, b) / maxLen)
    },
    _matchAgainst(spoken: string, expected: string, difficulty: string) {
      const thresholds: any = {
        easy: { levenshtein: 0.30, confidence: 0.60 },
        normal: { levenshtein: 0.20, confidence: 0.75 },
        strict: { levenshtein: 0.10, confidence: 0.85 },
      }
      const threshold = thresholds[difficulty]
      const normalizedSpoken = ArabicNormalizerTest.normalize(spoken, difficulty)
      const normalizedExpected = ArabicNormalizerTest.normalize(expected, difficulty)
      if (normalizedSpoken === normalizedExpected) return { match: true, confidence: 1.0, type: 'exact' }
      const sim = this.similarity(normalizedSpoken, normalizedExpected)
      const distRatio = 1 - sim
      if (distRatio <= threshold.levenshtein && sim >= threshold.confidence) return { match: true, confidence: sim, type: 'normalized' }
      return { match: false, confidence: sim, type: 'mismatch' }
    },
    matchWord(spoken: string, expected: any, difficulty = 'normal') {
      if (expected && typeof expected === 'object') {
        if (expected.text_imlaei) {
          const imlaeiResult = this._matchAgainst(spoken, expected.text_imlaei, difficulty)
          if (imlaeiResult.match) return imlaeiResult
        }
        const uthmaniResult = this._matchAgainst(spoken, expected.text_uthmani || '', difficulty)
        if (expected.text_imlaei) {
          const imlaeiResult = this._matchAgainst(spoken, expected.text_imlaei, difficulty)
          return uthmaniResult.match ? uthmaniResult : (uthmaniResult.confidence > imlaeiResult.confidence ? uthmaniResult : imlaeiResult)
        }
        return uthmaniResult
      }
      return this._matchAgainst(spoken, expected, difficulty)
    },
    isRepeatOfRevealed(spoken: string, expectedWords: any[], currentIdx: number, difficulty: string, revealedWords: Set<number>) {
      const normalizedSpoken = ArabicNormalizerTest.normalize(spoken, difficulty)
      for (const idx of revealedWords) {
        if (idx >= expectedWords.length) continue
        const w = expectedWords[idx]
        const texts = [w.text_imlaei, w.text_uthmani].filter(Boolean)
        for (const text of texts) {
          const norm = ArabicNormalizerTest.normalize(text, difficulty)
          if (normalizedSpoken === norm) return true
          if (this.similarity(normalizedSpoken, norm) >= 0.85) return true
        }
      }
      return false
    },
    checkOrderError(spoken: string, expectedWords: any[], currentIndex: number, difficulty: string) {
      const normalizedSpoken = ArabicNormalizerTest.normalize(spoken, difficulty)
      for (let i = currentIndex + 1; i < Math.min(currentIndex + 20, expectedWords.length); i++) {
        const w = expectedWords[i]
        const texts = [w.text_imlaei, w.text_uthmani].filter(Boolean)
        for (const text of texts) {
          if (normalizedSpoken === ArabicNormalizerTest.normalize(text, difficulty)) return true
        }
      }
      return false
    },
    matchSequence(spokenTokens: string[], expectedWords: any[], startIndex: number, difficulty: string, revealedWords: Set<number>) {
      const results: any[] = []
      let expectedIdx = startIndex
      for (let i = 0; i < spokenTokens.length && expectedIdx < expectedWords.length; i++) {
        const spoken = spokenTokens[i]
        if (!spoken || spoken.trim().length === 0) continue
        const expected = expectedWords[expectedIdx]
        const result = this.matchWord(spoken, expected, difficulty)
        if (result.match) {
          results.push({ wordIndex: expectedIdx, word: expected, confidence: result.confidence, matchType: result.type, spoken })
          expectedIdx++
          while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) expectedIdx++
        } else {
          let combinedMatch = false
          if (i + 1 < spokenTokens.length) {
            const combinedNoSpace = spoken + spokenTokens[i + 1]
            const combinedWithSpace = spoken + ' ' + spokenTokens[i + 1]
            let combResult = this.matchWord(combinedNoSpace, expected, difficulty)
            let usedCombined = combinedNoSpace
            if (!combResult.match) {
              combResult = this.matchWord(combinedWithSpace, expected, difficulty)
              usedCombined = combinedWithSpace
            }
            if (combResult.match) {
              results.push({ wordIndex: expectedIdx, word: expected, confidence: combResult.confidence, matchType: combResult.type, spoken: usedCombined })
              expectedIdx++
              while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) expectedIdx++
              i++
              combinedMatch = true
            }
            if (!combinedMatch && expectedIdx + 1 < expectedWords.length) {
              const exp1 = expected.text_imlaei || expected.text_uthmani
              const exp2 = expectedWords[expectedIdx+1].text_imlaei || expectedWords[expectedIdx+1].text_uthmani
              const twoExpected = exp1 + ' ' + exp2
              let twoResult = this.matchWord(spoken, twoExpected, difficulty)
              if (!twoResult.match) {
                const twoU = expected.text_uthmani + ' ' + expectedWords[expectedIdx+1].text_uthmani
                if (twoU !== twoExpected) twoResult = this.matchWord(spoken, twoU, difficulty)
              }
              if (twoResult.match) {
                results.push({ wordIndex: expectedIdx, word: expected, confidence: twoResult.confidence, matchType: twoResult.type, spoken })
                results.push({ wordIndex: expectedIdx + 1, word: expectedWords[expectedIdx + 1], confidence: twoResult.confidence, matchType: twoResult.type, spoken })
                expectedIdx += 2
                while (expectedIdx < expectedWords.length && revealedWords && revealedWords.has(expectedIdx)) expectedIdx++
                combinedMatch = true
              }
            }
          }
          if (!combinedMatch) {
            if (revealedWords && revealedWords.size > 0) {
              if (this.isRepeatOfRevealed(spoken, expectedWords, expectedIdx, difficulty, revealedWords)) continue
            }
            const isOrderError = this.checkOrderError(spoken, expectedWords, expectedIdx, difficulty)
            results.push({ wordIndex: expectedIdx, word: expected, confidence: result.confidence, matchType: 'error', errorType: isOrderError ? 'order' : (result.confidence > 0.4 ? 'pronunciation' : 'substitution'), spoken })
            break
          }
        }
      }
      return results
    }
  }

  let passed = 0
  let total = 15

  // ===== Test 1: Multi-word sequence =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650', text_imlaei: '\u0628\u0650\u0633\u0652\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650', text_imlaei: '\u0627\u0644\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650', text_imlaei: '\u0627\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0670\u0646\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650', text_imlaei: '\u0627\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0628\u0633\u0645', '\u0627\u0644\u0644\u0647', '\u0627\u0644\u0631\u062d\u0645\u0646', '\u0627\u0644\u0631\u062d\u064a\u0645'], words, 0, 'normal', new Set())
    if (results.length === 4 && results.every((r: any) => r.matchType !== 'error')) { console.log('\u2705 PASS: Test 1 - Multi-word sequence'); passed++ }
    else { console.error('\u274c FAIL: Test 1 - Got ' + results.length + ' results') }
  } catch (e: any) { console.error('\u274c FAIL: Test 1 - ' + e.message) }

  // ===== Test 2: Near repeat skipped =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650', text_imlaei: '\u0628\u0650\u0633\u0652\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650', text_imlaei: '\u0627\u0644\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650', text_imlaei: '\u0627\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0670\u0646\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650', text_imlaei: '\u0627\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0652\u062d\u064e\u0645\u0652\u062f\u064f', text_imlaei: '\u0627\u0644\u0652\u062d\u064e\u0645\u0652\u062f\u064f' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0628\u0633\u0645', '\u0627\u0644\u0644\u0647', '\u0627\u0644\u0631\u062d\u0645\u0646'], words, 2, 'normal', new Set([0,1]))
    if (results.length === 1 && results[0].wordIndex === 2 && results[0].matchType !== 'error') { console.log('\u2705 PASS: Test 2 - Near repeat skipped'); passed++ }
    else { console.error('\u274c FAIL: Test 2') }
  } catch (e: any) { console.error('\u274c FAIL: Test 2 - ' + e.message) }

  // ===== Test 3: Distant repeat skipped =====
  try {
    const wordTexts = ['\u0628\u0650\u0633\u0652\u0645\u0650','\u0671\u0644\u0644\u064e\u0651\u0647\u0650','\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650','\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650','\u0671\u0644\u0652\u062d\u064e\u0645\u0652\u062f\u064f','\u0644\u0650\u0644\u064e\u0651\u0647\u0650','\u0631\u064e\u0628\u0650\u0651','\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e','\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650','\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650','\u0645\u064e\u0640\u0670\u0644\u0650\u0643\u0650','\u064a\u064e\u0648\u0652\u0645\u0650','\u0671\u0644\u062f\u0650\u0651\u064a\u0646\u0650','\u0625\u0650\u064a\u064e\u0651\u0627\u0643\u064e','\u0646\u064e\u0639\u0652\u0628\u064f\u062f\u064f']
    const words = wordTexts.map(t => ({ text_uthmani: t }))
    const revealed = new Set<number>(); for (let i=0;i<14;i++) revealed.add(i)
    const results = WordMatcherTest.matchSequence(['\u0628\u0633\u0645', '\u0646\u0639\u0628\u062f'], words, 14, 'normal', revealed)
    if (results.length === 1 && results[0].wordIndex === 14 && results[0].matchType !== 'error') { console.log('\u2705 PASS: Test 3 - Distant repeat skipped'); passed++ }
    else { console.error('\u274c FAIL: Test 3') }
  } catch (e: any) { console.error('\u274c FAIL: Test 3 - ' + e.message) }

  // ===== Test 4: Real error detected =====
  try {
    const words = [{ text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650' }, { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650' }, { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650' }]
    const results = WordMatcherTest.matchSequence(['\u0643\u062a\u0627\u0628'], words, 1, 'normal', new Set([0]))
    if (results.length === 1 && results[0].matchType === 'error') { console.log('\u2705 PASS: Test 4 - Real error detected'); passed++ }
    else { console.error('\u274c FAIL: Test 4') }
  } catch (e: any) { console.error('\u274c FAIL: Test 4 - ' + e.message) }

  // ===== Test 5: Token merge =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650', text_imlaei: '\u0628\u0650\u0633\u0652\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650', text_imlaei: '\u0627\u0644\u0644\u064e\u0651\u0647\u0650' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0628\u0633', '\u0645', '\u0627\u0644\u0644\u0647'], words, 0, 'normal', new Set())
    if (results.length === 2 && results.every((r: any) => r.matchType !== 'error')) { console.log('\u2705 PASS: Test 5 - Token merge'); passed++ }
    else { console.error('\u274c FAIL: Test 5') }
  } catch (e: any) { console.error('\u274c FAIL: Test 5 - ' + e.message) }

  // ===== Test 6: Repeated Quran word not false-skipped =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650' }, { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650' }, { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0652\u062d\u064e\u0645\u0652\u062f\u064f' }, { text_uthmani: '\u0644\u0650\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0631\u064e\u0628\u0650\u0651' }, { text_uthmani: '\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650' }, { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0627\u0644\u0631\u062d\u0645\u0646', '\u0627\u0644\u0631\u062d\u064a\u0645'], words, 8, 'normal', new Set([0,1,2,3,4,5,6,7]))
    if (results.length === 2 && results[0].wordIndex === 8 && results[1].wordIndex === 9) { console.log('\u2705 PASS: Test 6 - Repeated Quran word matched correctly'); passed++ }
    else { console.error('\u274c FAIL: Test 6') }
  } catch (e: any) { console.error('\u274c FAIL: Test 6 - ' + e.message) }

  // ===== Test 7: Single-token interim =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650', text_imlaei: '\u0628\u0650\u0633\u0652\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650', text_imlaei: '\u0627\u0644\u0644\u064e\u0651\u0647\u0650' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0627\u0644\u0644\u0647'], words, 1, 'normal', new Set([0]))
    if (results.length === 1 && results[0].wordIndex === 1 && results[0].matchType !== 'error') { console.log('\u2705 PASS: Test 7 - Single-token interim'); passed++ }
    else { console.error('\u274c FAIL: Test 7') }
  } catch (e: any) { console.error('\u274c FAIL: Test 7 - ' + e.message) }

  // ===== Test 8: Re-reading earlier words =====
  try {
    const words = [
      { text_uthmani: '\u0628\u0650\u0633\u0652\u0645\u0650' }, { text_uthmani: '\u0671\u0644\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650' }, { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
      { text_uthmani: '\u0671\u0644\u0652\u062d\u064e\u0645\u0652\u062f\u064f' }, { text_uthmani: '\u0644\u0650\u0644\u064e\u0651\u0647\u0650' },
      { text_uthmani: '\u0631\u064e\u0628\u0650\u0651' }, { text_uthmani: '\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e' },
      { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650' }, { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0650\u064a\u0645\u0650' },
    ]
    const results = WordMatcherTest.matchSequence(['\u0631\u0628', '\u0627\u0644\u0639\u0627\u0644\u0645\u064a\u0646', '\u0627\u0644\u0631\u062d\u0645\u0646'], words, 8, 'normal', new Set([0,1,2,3,4,5,6,7]))
    if (results.length === 1 && results[0].wordIndex === 8 && results[0].matchType !== 'error') { console.log('\u2705 PASS: Test 8 - Re-reading then matching current'); passed++ }
    else { console.error('\u274c FAIL: Test 8 - Results: ' + JSON.stringify(results.map((r:any)=>({idx:r.wordIndex,type:r.matchType})))) }
  } catch (e: any) { console.error('\u274c FAIL: Test 8 - ' + e.message) }

  // ===== Test 9: CRITICAL - Ottoman vs ASR (small alef \u2192 regular alef) =====
  // ASR says "\u0627\u0644\u0639\u0627\u0644\u0645\u064a\u0646" but Quran has "\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e" (with small alef \u0670 instead of \u0627)
  try {
    const word = { text_uthmani: '\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e', text_imlaei: '\u0627\u0644\u0652\u0639\u064e\u0627\u0644\u064e\u0645\u0650\u064a\u0646\u064e' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0639\u0627\u0644\u0645\u064a\u0646', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 9 - Ottoman small alef \u2192 ASR regular alef matched (\u0627\u0644\u0639\u0627\u0644\u0645\u064a\u0646)'); passed++ }
    else { console.error('\u274c FAIL: Test 9 - Ottoman "\u0671\u0644\u0652\u0639\u064e\u0640\u0670\u0644\u064e\u0645\u0650\u064a\u0646\u064e" should match ASR "\u0627\u0644\u0639\u0627\u0644\u0645\u064a\u0646". Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 9 - ' + e.message) }

  // ===== Test 10: CRITICAL - Ottoman \u0635\u0650\u0631\u064e\u0670\u0637 vs ASR \u0627\u0644\u0635\u0631\u0627\u0637 (superscript alef) =====
  try {
    const word = { text_uthmani: '\u0671\u0644\u0635\u0650\u0651\u0631\u064e\u0670\u0637\u064e', text_imlaei: '\u0627\u0644\u0635\u0650\u0651\u0631\u064e\u0627\u0637\u064e' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0635\u0631\u0627\u0637', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 10 - Ottoman superscript alef \u0670 matched (\u0627\u0644\u0635\u0631\u0627\u0637)'); passed++ }
    else { console.error('\u274c FAIL: Test 10 - "\u0671\u0644\u0635\u0650\u0651\u0631\u064e\u0670\u0637\u064e" should match "\u0627\u0644\u0635\u0631\u0627\u0637". Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 10 - ' + e.message) }

  // ===== Test 11: CRITICAL - \u0627\u0644\u0631\u062d\u0645\u0646 with dagger alef in both uthmani and imlaei =====
  // Dagger alef (U+0670) should be REMOVED, not converted to regular alef
  // ASR says "\u0627\u0644\u0631\u062d\u0645\u0646" not "\u0627\u0644\u0631\u062d\u0645\u0627\u0646"
  try {
    const word = { text_uthmani: '\u0671\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u064e\u0640\u0670\u0646\u0650', text_imlaei: '\u0627\u0644\u0631\u064e\u0651\u062d\u0652\u0645\u0670\u0646\u0650' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0631\u062d\u0645\u0646', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 11 - \u0627\u0644\u0631\u062d\u0645\u0646 with dagger alef removed (not converted to \u0627)'); passed++ }
    else { console.error('\u274c FAIL: Test 11 - "\u0627\u0644\u0631\u062d\u0645\u0646" should match. Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 11 - ' + e.message) }

  // ===== Test 12: \u0623\u0648\u0644\u0626\u0643 with dagger alef + small high rounded zero =====
  try {
    const word = { text_uthmani: '\u0623\u064f\u0648\u06df\u0644\u064e\u0640\u0670\u0653\u0626\u0650\u0643\u064e', text_imlaei: '\u0623\u064f\u0648\u0644\u064e\u0670\u0626\u0650\u0643\u064e' }
    const result = WordMatcherTest.matchWord('\u0627\u0648\u0644\u0626\u0643', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 12 - \u0623\u0648\u0644\u0626\u0643 matched despite Ottoman marks'); passed++ }
    else { console.error('\u274c FAIL: Test 12 - "\u0627\u0648\u0644\u0626\u0643" should match. Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 12 - ' + e.message) }

  // ===== Test 13: \u0627\u0644\u0643\u062a\u0627\u0628 with tatweel+dagger alef =====
  try {
    const word = { text_uthmani: '\u0671\u0644\u0652\u0643\u0650\u062a\u064e\u0640\u0670\u0628\u064f', text_imlaei: '\u0627\u0644\u0652\u0643\u0650\u062a\u064e\u0627\u0628\u064f' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0643\u062a\u0627\u0628', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 13 - \u0627\u0644\u0643\u062a\u0627\u0628 matched via imlaei text'); passed++ }
    else { console.error('\u274c FAIL: Test 13 - "\u0627\u0644\u0643\u062a\u0627\u0628" should match. Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 13 - ' + e.message) }

  // ===== Test 14: \u0627\u0644\u0635\u0644\u0627\u0629 - Ottoman \u0627\u0644\u0635\u0644\u0648\u0629 vs standard \u0627\u0644\u0635\u0644\u0627\u0629 =====
  try {
    const word = { text_uthmani: '\u0671\u0644\u0635\u064e\u0651\u0644\u064e\u0648\u0670\u0629\u064e', text_imlaei: '\u0627\u0644\u0635\u064e\u0651\u0644\u064e\u0627\u0629\u064e' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0635\u0644\u0627\u0629', word, 'easy')
    if (result.match) { console.log('\u2705 PASS: Test 14 - \u0627\u0644\u0635\u0644\u0627\u0629 matched via imlaei (Ottoman has \u0627\u0644\u0635\u0644\u0648\u0629)'); passed++ }
    else { console.error('\u274c FAIL: Test 14 - "\u0627\u0644\u0635\u0644\u0627\u0629" should match. Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 14 - ' + e.message) }

  // ===== Test 15: \u0627\u0644\u0633\u0645\u0627\u0648\u0627\u062a with multiple dagger alefs =====
  try {
    const word = { text_uthmani: '\u0671\u0644\u0633\u064e\u0651\u0645\u064e\u0640\u0670\u0648\u064e\u0670\u062a\u0650', text_imlaei: '\u0627\u0644\u0633\u064e\u0651\u0645\u064e\u0627\u0648\u064e\u0627\u062a\u0650' }
    const result = WordMatcherTest.matchWord('\u0627\u0644\u0633\u0645\u0627\u0648\u0627\u062a', word, 'normal')
    if (result.match) { console.log('\u2705 PASS: Test 15 - \u0627\u0644\u0633\u0645\u0627\u0648\u0627\u062a matched via imlaei (multiple dagger alefs)'); passed++ }
    else { console.error('\u274c FAIL: Test 15 - "\u0627\u0644\u0633\u0645\u0627\u0648\u0627\u062a" should match. Confidence: ' + result.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 15 - ' + e.message) }

  // ========================================
  // PAUSE MARK TESTS (U+06D6-U+06DC)
  // ========================================
  total++
  try {
    // U+06DB (three dots ۛ) - رَيْبَ ۛ should match ريب
    const word16 = { text_uthmani: '\u0631\u064E\u064A\u0652\u0628\u064E \u06DB', text_imlaei: '\u0631\u064E\u064A\u0652\u0628\u064E \u06DB' }
    const result16 = WordMatcherTest.matchWord('\u0631\u064a\u0628', word16, 'normal')
    if (result16.match) { console.log('\u2705 PASS: Test 16 - Pause mark \u06DB (three dots) removed from \u0631\u064E\u064A\u0652\u0628\u064E \u06DB'); passed++ }
    else { console.error('\u274c FAIL: Test 16 - "\u0631\u064a\u0628" should match "\u0631\u064E\u064A\u0652\u0628\u064E \u06DB". Confidence: ' + result16.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 16 - ' + e.message) }

  total++
  try {
    // U+06D6 (صلى ۖ) - رَّبِّهِمْ ۖ should match ربهم
    const word17 = { text_uthmani: '\u0631\u064E\u0651\u0628\u0650\u0651\u0647\u0650\u0645\u0652 \u06D6', text_imlaei: '\u0631\u064E\u0651\u0628\u0650\u0651\u0647\u0650\u0645\u0652 \u06D6' }
    const result17 = WordMatcherTest.matchWord('\u0631\u0628\u0647\u0645', word17, 'normal')
    if (result17.match) { console.log('\u2705 PASS: Test 17 - Pause mark \u06D6 (\u0635\u0644\u0649) removed from \u0631\u064E\u0651\u0628\u0650\u0651\u0647\u0650\u0645\u0652 \u06D6'); passed++ }
    else { console.error('\u274c FAIL: Test 17 - "\u0631\u0628\u0647\u0645" should match. Confidence: ' + result17.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 17 - ' + e.message) }

  total++
  try {
    // U+06D7 (قلى ۗ) - ٱلسُّفَهَآءُ ۗ should match السفهاء
    const word18 = { text_uthmani: '\u0671\u0644\u0633\u064F\u0651\u0641\u064E\u0647\u064E\u0622\u0621\u064F \u06D7', text_imlaei: '\u0627\u0644\u0633\u064F\u0651\u0641\u064E\u0647\u064E\u0627\u0621\u064F \u06D7' }
    const result18 = WordMatcherTest.matchWord('\u0627\u0644\u0633\u0641\u0647\u0627\u0621', word18, 'normal')
    if (result18.match) { console.log('\u2705 PASS: Test 18 - Pause mark \u06D7 (\u0642\u0644\u0649) removed from \u0671\u0644\u0633\u064F\u0651\u0641\u064E\u0647\u064E\u0622\u0621\u064F \u06D7'); passed++ }
    else { console.error('\u274c FAIL: Test 18 - "\u0627\u0644\u0633\u0641\u0647\u0627\u0621" should match. Confidence: ' + result18.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 18 - ' + e.message) }

  total++
  try {
    // U+06DA (ج ۚ) - ٱلْمَوْتِ ۚ should match الموت
    const word19 = { text_uthmani: '\u0671\u0644\u0652\u0645\u064E\u0648\u0652\u062A\u0650 \u06DA', text_imlaei: '\u0627\u0644\u0652\u0645\u064E\u0648\u0652\u062A\u0650 \u06DA' }
    const result19 = WordMatcherTest.matchWord('\u0627\u0644\u0645\u0648\u062a', word19, 'normal')
    if (result19.match) { console.log('\u2705 PASS: Test 19 - Pause mark \u06DA (\u062C) removed from \u0671\u0644\u0652\u0645\u064E\u0648\u0652\u062A\u0650 \u06DA'); passed++ }
    else { console.error('\u274c FAIL: Test 19 - "\u0627\u0644\u0645\u0648\u062a" should match. Confidence: ' + result19.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 19 - ' + e.message) }

  total++
  try {
    // Test strict mode also handles pause marks
    const word20 = { text_uthmani: '\u0631\u064E\u064A\u0652\u0628\u064E \u06DB', text_imlaei: '\u0631\u064E\u064A\u0652\u0628\u064E \u06DB' }
    const result20 = WordMatcherTest.matchWord('\u0631\u064E\u064A\u0652\u0628\u064E', word20, 'strict')
    if (result20.match) { console.log('\u2705 PASS: Test 20 - Pause mark removed in STRICT mode too'); passed++ }
    else { console.error('\u274c FAIL: Test 20 - Strict mode should also remove pause marks. Confidence: ' + result20.confidence) }
  } catch (e: any) { console.error('\u274c FAIL: Test 20 - ' + e.message) }

  console.log('=== \u0646\u062a\u064a\u062c\u0629 \u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a: ' + passed + '/' + total + ' ===')
  return { passed, total }
}
/* END TEST */
