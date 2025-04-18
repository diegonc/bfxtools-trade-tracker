import '../config/index.js'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import fs from 'fs'
import { JWT } from 'google-auth-library'
import { GoogleSpreadsheet } from 'google-spreadsheet'

import { getBalance } from '../bitfinex-utils.js'
import { DateToValue } from './gsheets-date-utils.js'
import createLogger from '../logging.js'

dayjs.extend(utc)
const logger = createLogger('gsheets')

const credentials = JSON.parse(
  fs.readFileSync(process.env.GOOGLE_ACCOUNT_JSON_FILE)
)
const workbookId = process.env.GOOGLE_WORKBOOK_ID
const scopes = ['https://www.googleapis.com/auth/spreadsheets']
const jwt = new JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes,
})

const headerColor = {
  red: 0xe6 / 255,
  green: 0xb8 / 255,
  blue: 0xaf / 255,
}

const readOnlyColor = {
  red: 0xda / 255,
  green: 0xe9 / 255,
  blue: 0xf8 / 255,
}

const headerValues = [
  'Id',
  'Date',
  'Type',
  'Size',
  'Exc. Price',
  'Funding Amt',
  'Fee',
  'Base Price',
  'Sell Amt',
  'Fee Amt',
  'Balance',
]

export class Gsheet {
  constructor(gsheetApi, walletType, walletCurrency) {
    this._api = gsheetApi
    this._book = new GoogleSpreadsheet(workbookId, jwt)
    this._walletType = walletType
    this._walletCurrency = walletCurrency
  }

  async _getCurrentSheet(book) {
    const sheet = book.sheetsByTitle['Index']
    const count = sheet.rowCount
    const rows = await sheet.getRows({ offset: 0, limit: count })
    for (const row of rows) {
      const status = row.get('Status')
      if (status === 'IN PROGRESS') {
        return row.get('Sheet Title')
      }
    }

    return null
  }

  async _finishSheet(book, sheetTitle) {
    const sheet = book.sheetsByTitle['Index']
    const count = sheet.rowCount
    const rows = await sheet.getRows({ offset: 0, limit: count })
    for (const row of rows) {
      const title = row.get('Sheet Title')
      if (title === sheetTitle) {
        row.set('Status', 'DONE')
        row.save({ raw: true })
        break
      }
    }
  }

  async _createNewSheet(book, walletType, walletCurrency) {
    const indexSheet = book.sheetsByTitle['Index']
    const now = dayjs.utc()
    const dataSheet = await book.addSheet({ headerValues })

    await dataSheet.loadCells('A1:K2')
    for (let i = 0; i < headerValues.length; i++) {
      const cell = dataSheet.getCell(0, i)
      cell.backgroundColor = headerColor
      cell.textFormat = { bold: true }
      cell.horizontalAlignment = 'CENTER'
    }
    /* Fill in the Start row */
    const dateCell = dataSheet.getCell(1, 1)
    dateCell.numberFormat = {
      type: 'DATE_TIME',
      pattern: 'yyyy/mm/dd hh:mm:ss',
    }
    dateCell.numberValue = DateToValue(now.toDate())
    const typeCell = dataSheet.getCell(1, 2)
    typeCell.value = 'Start'
    const balanceCell = dataSheet.getCell(1, headerValues.length - 1)
    const balance = await getBalance(walletType, walletCurrency)
    balanceCell.numberFormat = {
      type: 'NUMBER',
      pattern: '#0.00000000',
    }
    balanceCell.numberValue = balance

    /* Set row background */
    for (let i = 0; i < headerValues.length; i++) {
      const cell = dataSheet.getCell(1, i)
      cell.backgroundColor = readOnlyColor
    }
    await dataSheet.saveUpdatedCells()

    const title = now.format('YYYY-MM-DDTHH:mm:ss')
    await dataSheet.updateProperties({ title: title })
    await indexSheet.addRow(
      { 'Sheet Title': title, Status: 'IN PROGRESS' },
      { raw: true }
    )
    return title
  }

  async _findSheetParameters(walletType, walletCurrency) {
    await this._book.loadInfo()
    let currentSheetTitle =
      (await this._getCurrentSheet(this._book)) ||
      (await this._createNewSheet(this._book, walletType, walletCurrency))

    let sheet = this._book.sheetsByTitle[currentSheetTitle]
    await sheet.loadCells()

    let inProgress = false
    let positionSize = 0
    let nextRow = 0
    while (true) {
      const cell = sheet.getCell(nextRow, 2)
      if (!cell.value) {
        break
      } else {
        const size = sheet.getCell(nextRow, 3)
        if ((nextRow > 1 && size.value) || size.value === 0) {
          inProgress = true
          positionSize += +size.value
        }
        nextRow++
      }
    }

    if (inProgress && positionSize === 0) {
      await this._finishSheet(this._book, sheet.title)
      currentSheetTitle = await this._createNewSheet(
        this._book,
        walletType,
        walletCurrency
      )
      nextRow = 2
      sheet = this._book.sheetsByTitle[currentSheetTitle]
      await sheet.loadCells()
    }

    return {
      sheetTitle: currentSheetTitle,
      inProgress,
      positionSize,
      nextRow,
    }
  }

  async setupWorkingSheet(walletType, walletCurrency) {
    const { sheetTitle, inProgress, positionSize, nextRow } =
      await this._findSheetParameters(walletType, walletCurrency)

    this._sheetTitle = sheetTitle
    this._positionSize = positionSize
    this._nextRow = nextRow
    this._sheet = this._book.sheetsByTitle[sheetTitle]
  }

  async _nextSheet() {
    await this._finishSheet(this._book, this._sheetTitle)
    const newSheetTitle = await this._createNewSheet(
      this._book,
      this._walletType,
      this._walletCurrency
    )
    const nextRow = 2
    const sheet = this._book.sheetsByTitle[newSheetTitle]
    await sheet.loadCells()

    /* Update this object state */
    this._sheetTitle = newSheetTitle
    this._positionSize = 0
    this._nextRow = nextRow
    this._sheet = sheet

    logger.info(
      'Working on current sheet %s, nextRow = %d, positionSize = %f',
      this._sheetTitle,
      this._nextRow,
      this._positionSize
    )
  }

  async _addRow(inputRow) {
    const nextRow = this._nextRow
    for (let i = 0; i < headerValues.length; i++) {
      const cell = this._sheet.getCell(nextRow, i)
      if (i > 6 || nextRow === 2) {
        cell.backgroundColor = readOnlyColor
      }
      switch (i) {
        case 0:
          cell.numberValue = inputRow[i]
          break
        case 1:
          cell.numberFormat = {
            type: 'DATE_TIME',
            pattern: 'yyyy/mm/dd hh:mm:ss',
          }
          cell.numberValue = DateToValue(inputRow[i].toDate())
          break
        case 2:
          cell.stringValue = inputRow[i]
          break
        case 3:
        case 4:
        case 5:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.00000000',
          }
          cell.numberValue = inputRow[i]
          break
        case 6:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.000%',
          }
          cell.numberValue = inputRow[i]
          break
        case 7:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.00000000',
          }
          cell.formula = `=ROUNDUP((H${nextRow}*SUM($D$2:D${nextRow})+IF(C${
            nextRow + 1
          }="Buy";(D${nextRow + 1}*E${
            nextRow + 1
          });0))/(SUM($D$2:D${nextRow})+IF(C${nextRow + 1}="Buy";D${
            nextRow + 1
          };0));8)`
          break
        case 8:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.00000000',
          }
          cell.formula = `=IF(C${nextRow + 1}="Sell";(E${nextRow + 1}-H${
            nextRow + 1
          })*D${nextRow + 1};0)`
          break
        case 9:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.00000000',
          }
          cell.formula = `=-ABS(ROUND(D${nextRow + 1}*E${nextRow + 1}*G${
            nextRow + 1
          };8))`
          break
        case 10:
          cell.numberFormat = {
            type: 'NUMBER',
            pattern: '#0.00000000',
          }
          cell.formula = `=I${nextRow + 1}+K${nextRow}+J${nextRow + 1}+F${
            nextRow + 1
          }`
          break
      }
    }
    await this._sheet.saveUpdatedCells()
  }

  async addTrade(trade) {
    const fee = Math.abs(trade.fee / (trade.execAmount * trade.execPrice))
    const type = -trade.execAmount < 0 ? 'Buy' : 'Sell'
    const inputRow = [
      trade.id,
      dayjs.utc(trade.mts),
      type,
      -trade.execAmount,
      trade.execPrice,
      0,
      fee,
    ]
    await this._addRow(inputRow)
    this._nextRow++
    this._positionSize += -trade.execAmount
    if (this._positionSize === 0) {
      await this._nextSheet()
    }
  }

  async addFunding(funding) {
    const inputRow = [
      '',
      dayjs.utc(funding.statusTs),
      'Funding',
      0,
      0,
      +(this._positionSize * funding.markPrice * funding.funding).toFixed(8),
      0,
    ]
    await this._addRow(inputRow)
  }
}
