import 'dotenv/config'
import fs from 'fs'

if (
  !process.env.GOOGLE_ACCOUNT_JSON_FILE ||
  !fs.existsSync(process.env.GOOGLE_ACCOUNT_JSON_FILE)
) {
  throw new Error('GOOGLE Account configuration is missing')
}

if (!process.env.GOOGLE_WORKBOOK_ID) {
  throw new Error('GOOGLE Workbook configuration is missing')
}

if (!process.env.BITFINEX_API_KEY || !process.env.BITFINEX_API_KEY_SECRET) {
  throw new Error('Bitfinex API configuration is missing')
}
