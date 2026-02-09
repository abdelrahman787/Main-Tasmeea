# Quran Tasmee3 - تسميع القرآن

A web application for Quran memorization through word-by-word recitation testing. The app hides Quranic text and reveals words only when correctly recited, using speech recognition technology.

## Live Demo
- **Sandbox URL**: [Access via GetServiceUrl on port 3000]
- **Platform**: Cloudflare Pages (Hono + Workers)

## Features

### Core Functionality
- **Word-by-Word Recitation**: Full Mushaf page displayed, text hidden during session. Each correctly recited word is revealed with smooth animation
- **Speech Recognition**: Uses Web Speech API (Arabic) for real-time speech-to-text
- **Multi-Word Support**: Accepts continuous recitation - multiple words/ayat in one breath
- **Strict Order Enforcement**: Words only reveal in correct Quranic order
- **Manual Assistance**: "Reveal Word" and "Reveal Ayah" buttons for when stuck

### Word Matching Engine
- **3 Difficulty Modes**:
  - **Easy**: Levenshtein distance <=30%, confidence >=60%, phonetic matching
  - **Normal**: Levenshtein distance <=20%, confidence >=75%
  - **Strict**: Levenshtein distance <=10%, confidence >=85%
- **Arabic Text Normalization**: Diacritics removal, Alif/Ya/Ta Marbuta normalization
- **Phonetic Matching**: Additional Arabic phonetic similarity for Easy mode

### Error Classification
- **Forget**: Prolonged silence (>=10s) or manual reveal
- **Substitution**: Different valid Arabic word spoken
- **Order Error**: Correct word but wrong position
- **Pronunciation Error**: Text matches after normalization but low confidence

### Error Recording Rules
- Attempt 1: No error recorded
- Attempt 2: Soft error recorded
- Attempt 3+: Confirmed error
- All attempts linked to same word within session

### Session Analytics
- Accuracy percentage per session
- Correct words / total words
- Error count with detailed breakdown
- Duration tracking
- Error type classification (Forget, Substitution, Order, Pronunciation)
- Most problematic words across sessions

### UI/UX
- **RTL Layout**: Full right-to-left Arabic interface
- **Light/Dark Mode**: Toggle with persistent preference
- **Authentic Typography**: Amiri Quran, Noto Naskh Arabic fonts
- **Mushaf-Style Page**: Gold-bordered page with traditional styling
- **Page Navigation**: RTL page-turn, page number input (1-604)
- **Surah Index**: Browse and jump to any Surah
- **Listening Indicator**: Animated pulse showing active recording
- **Progress Bar**: Visual session completion tracking
- **Onboarding**: 3-step introduction for first-time users

### Silence Handling
- 5s silence: "Listening..." indicator
- 10s silence: Registers Forget error, prompts user
- Never auto-advances without valid input

### ASR Failure Handling
- Empty/unusable ASR text: No error recorded, auto-retry
- 3 consecutive ASR failures: "Audio unclear" warning

## Tech Stack
- **Backend**: Hono (TypeScript) on Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite) for session persistence
- **Frontend**: Vanilla JS with Tailwind CSS (CDN)
- **Fonts**: Google Fonts (Amiri Quran, Noto Naskh Arabic)
- **Icons**: Font Awesome
- **Speech**: Web Speech API (SpeechRecognition)
- **Quran Data**: quran.com API v4 (word-by-word with Uthmani script)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/quran/page/:pageNumber` | Get word-by-word Quran data for a page (1-604) |
| GET | `/api/quran/surahs` | Get list of all 114 Surahs |
| GET | `/api/quran/surah/:id` | Get Surah details |
| POST | `/api/sessions` | Save a recitation session |
| GET | `/api/sessions` | Get session history |
| GET | `/api/sessions/:id` | Get session details with errors |
| POST | `/api/sessions/:id/errors` | Save error logs for a session |

## Data Models

### Session
- id, user_id, start_time, end_time
- mode, difficulty, scope_type, scope_value
- total_words, correct_words, errors_count, duration_seconds

### ErrorLog
- session_id, word_location, expected_text, recognized_text
- error_type (forget/substitution/order/pronunciation)
- attempts, page_number, line_number, severity

## Project Structure
```
webapp/
├── src/
│   └── index.tsx          # Main Hono app (API + HTML rendering)
├── migrations/
│   └── 0001_initial_schema.sql  # D1 database schema
├── ecosystem.config.cjs   # PM2 configuration
├── wrangler.jsonc         # Cloudflare Workers config
├── vite.config.ts         # Vite build configuration
├── tsconfig.json          # TypeScript config
├── package.json           # Dependencies and scripts
└── README.md
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally with D1
npm run db:migrate:local
npm run dev:sandbox

# Reset local database
npm run db:reset
```

## Deployment

```bash
# Deploy to Cloudflare Pages
npm run deploy

# Apply migrations to production
npm run db:migrate:prod
```

## Browser Requirements
- Chrome 33+ or Edge 79+ (for Web Speech API Arabic support)
- Microphone access required for recitation
- Works on both desktop and mobile

## Not Yet Implemented
- User authentication (Email/Phone/OAuth)
- Offline mode with local ASR (Whisper/Vosk)
- Audio recording and playback
- Custom recitation scope (verse range selection)
- Tajweed-aware strict mode scoring
- Configurable matching thresholds UI
- Multi-user profiles
- Export/import session data

## Next Steps
1. Add user authentication for persistent cross-device profiles
2. Implement verse-range selection for custom recitation scope
3. Add audio recording opt-in for review
4. Integrate Whisper API for better Arabic ASR accuracy
5. Add Tajweed analysis in strict mode
6. Implement spaced repetition for problematic words
7. Add QCF v2 font rendering for pixel-perfect Mushaf display
