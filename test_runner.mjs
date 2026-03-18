import { runTests } from './src/index.tsx'
const { passed, total } = runTests()
process.exit(passed === total ? 0 : 1)
