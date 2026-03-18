// Test with REAL Quran page data to verify Ottoman → ASR matching
import { runTests } from './src/index.tsx'

// First run normal tests
const { passed: p1, total: t1 } = runTests()
console.log('')

// Now test real-world scenarios with CORRECT normalizer (U+0670 REMOVED, not converted)
const ArabicNormalizer = {
  normalizeOttoman(text) {
    return text
      .replace(/\u0670/g, '')  // REMOVE dagger alef (diacritical mark)
      .replace(/\u06DF/g, '')
      .replace(/\u0653/g, '')
      .replace(/\u0654/g, '')
      .replace(/\u0655/g, '')
      .replace(/\u0656/g, '')
      .replace(/\u06E5/g, '')
      .replace(/\u06E6/g, '')
      .replace(/\u0621\u0627/g, '\u0622')
  },
  removeDiacritics(text) {
    return text.replace(/[\u0610-\u061A\u064B-\u065F\u06D6-\u06DC\u06E0-\u06E8\u06EA-\u06ED\u08D4-\u08E1\u08D4-\u08ED\u08F0-\u08F3]/g, '')
  },
  normalizeAlif(text) { return text.replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') },
  normalizeYa(text) { return text.replace(/\u0649/g, '\u064a') },
  normalizeTaMarbuta(text) { return text.replace(/\u0629/g, '\u0647') },
  removeTatweel(text) { return text.replace(/\u0640/g, '') },
  normalize(text, level = 'normal') {
    if (!text) return ''
    let normalized = text.trim()
    normalized = this.normalizeOttoman(normalized)
    normalized = this.removeTatweel(normalized)
    normalized = normalized.replace(/\s+/g, ' ').trim()
    if (level === 'strict') { normalized = this.normalizeAlif(normalized); return normalized }
    normalized = this.removeDiacritics(normalized)
    normalized = this.normalizeAlif(normalized)
    normalized = this.normalizeYa(normalized)
    if (level === 'easy') { normalized = this.normalizeTaMarbuta(normalized) }
    return normalized
  }
}

console.log('=== Real-world Ottoman → Standard Arabic normalization tests ===')
const testCases = [
  { uthmani: 'ٱلْكِتَـٰبُ', imlaei: 'الْكِتَابُ', asr: 'الكتاب', desc: 'الكتاب (tatweel+small alef)' },
  { uthmani: 'ٱلصَّلَوٰةَ', imlaei: 'الصَّلَاةَ', asr: 'الصلاة', desc: 'الصلاة (superscript alef)' },
  { uthmani: 'رَزَقْنَـٰهُمْ', imlaei: 'رَزَقْنَاهُمْ', asr: 'رزقناهم', desc: 'رزقناهم (tatweel+small alef)' },
  { uthmani: 'أُو۟لَـٰٓئِكَ', imlaei: 'أُولَٰئِكَ', asr: 'اولئك', desc: 'اولئك (small high rounded zero)' },
  { uthmani: 'ءَأَنذَرْتَهُمْ', imlaei: 'أَأَنذَرْتَهُمْ', asr: 'أأنذرتهم', desc: 'أأنذرتهم (hamza + alef)' },
  { uthmani: 'فِى', imlaei: 'فِي', asr: 'في', desc: 'في (alif maqsura → ya)' },
  { uthmani: 'ٱلْعَـٰلَمِينَ', imlaei: 'الْعَالَمِينَ', asr: 'العالمين', desc: 'العالمين (small alef in middle)' },
  { uthmani: 'ٱلرَّحْمَـٰنِ', imlaei: 'الرَّحْمٰنِ', asr: 'الرحمن', desc: 'الرحمن (tatweel+small alef)' },
  { uthmani: 'ٱلصِّرَٰطَ', imlaei: 'الصِّرَاطَ', asr: 'الصراط', desc: 'الصراط (superscript alef)' },
  { uthmani: 'ٱلْمُسْتَقِيمَ', imlaei: 'الْمُستَقِيمَ', asr: 'المستقيم', desc: 'المستقيم (alef wasla)' },
  { uthmani: 'ٱلضَّآلِّينَ', imlaei: 'الضَّالِّينَ', asr: 'الضالين', desc: 'الضالين (alef madda)' },
  { uthmani: 'ٱهْدِنَا', imlaei: 'اهْدِنَا', asr: 'اهدنا', desc: 'اهدنا (alef wasla)' },
  { uthmani: 'ٱلصَّـٰلِحَـٰتِ', imlaei: 'الصَّالِحَاتِ', asr: 'الصالحات', desc: 'الصالحات (multiple small alefs)' },
  { uthmani: 'قَوَّٰمِينَ', imlaei: 'قَوَّامِينَ', asr: 'قوامين', desc: 'قوامين (superscript alef)' },
  { uthmani: 'ٱلسَّمَـٰوَٰتِ', imlaei: 'السَّمَاوَاتِ', asr: 'السماوات', desc: 'السماوات (multiple small alefs)' },
]

let passed2 = 0
for (const tc of testCases) {
  const normUthmani = ArabicNormalizer.normalize(tc.uthmani, 'normal')
  const normImlaei = ArabicNormalizer.normalize(tc.imlaei, 'normal')
  const normAsr = ArabicNormalizer.normalize(tc.asr, 'normal')
  const matchesUthmani = normAsr === normUthmani
  const matchesImlaei = normAsr === normImlaei
  if (matchesUthmani || matchesImlaei) {
    console.log(`✅ ${tc.desc}: ASR="${normAsr}" matches ${matchesImlaei ? 'imlaei' : 'uthmani'}="${matchesImlaei ? normImlaei : normUthmani}"`)
    passed2++
  } else {
    console.log(`❌ ${tc.desc}:`)
    console.log(`   ASR      = "${normAsr}"`)
    console.log(`   Uthmani  = "${normUthmani}"`)
    console.log(`   Imlaei   = "${normImlaei}"`)
  }
}
console.log(`\n=== Real-world results: ${passed2}/${testCases.length} ===`)
process.exit(p1 === t1 && passed2 === testCases.length ? 0 : 1)
