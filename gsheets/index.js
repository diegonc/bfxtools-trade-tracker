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

export class MemoryBackend {
  constructor(walletType, walletCurrency) {
    this._logger = createLogger('memorybackend')
    this._walletType = walletType
    this._walletCurrency = walletCurrency
    this._book = [{ title: 'Index', cells: [['Sheet Title', 'Status']] }]
  }

  _getCurrentSheet() {
    const sheet = this._book.find((s) => s.title === 'Index')
    for (const row of sheet.cells) {
      if (row[1] === 'IN PROGRESS') {
        return row[0]
      }
    }
    return null
  }

  _addSheet({ headerValues }) {
    const row = [...headerValues]
    const cells = [row]
    const sheet = { title: 'Untitled', cells }
    this._book.push(sheet)
    return sheet
  }

  _finishSheet(sheetTitle) {
    const sheet = this._book.find((s) => s.title === 'Index')

    for (const row of sheet.cells) {
      const title = row[0]
      if (title === sheetTitle) {
        row[1] = 'DONE'
        break
      }
    }
  }

  /* rowNum is one-based index */
  _ensureRow(sheet, rowNum) {
    let missing = rowNum - sheet.cells.length
    if (missing <= 0) {
      return true
    }

    /* add `missing` rows to the cells array using the header row as template */
    const rowTemplate = sheet.cells[0].map((cell) => '')
    while (missing > 0) {
      sheet.cells.push([].concat(rowTemplate))
      missing--
    }
    return true
  }

  async _createNewSheet() {
    const indexSheet = this._book.find((s) => s.title === 'Index')
    const now = dayjs.utc()
    const dataSheet = this._addSheet({ headerValues })

    /* Fill in the Start row */
    this._ensureRow(dataSheet, 2)
    dataSheet.cells[1][1] = now.toDate()
    dataSheet.cells[1][2] = 'Start'
    dataSheet.cells[1][headerValues.length - 1] = await getBalance(
      this._walletType,
      this._walletCurrency
    )

    const title = now.format('YYYY-MM-DDTHH:mm:ss')
    dataSheet.title = title
    /* Add new sheet to index */
    indexSheet.cells.push([title, 'IN PROGRESS'])
    return title
  }

  async _findSheetParameters() {
    let currentSheetTitle =
      this._getCurrentSheet() || (await this._createNewSheet())

    let sheet = this._book.find((s) => s.title === currentSheetTitle)

    let inProgress = false
    let positionSize = 0
    let nextRow = 0
    while (nextRow < sheet.cells.length) {
      const cell = sheet.cells[nextRow][2]
      if (!cell) {
        break
      } else {
        const size = sheet.cells[nextRow][3]
        if ((nextRow > 1 && size) || size === 0) {
          inProgress = true
          /* XXX convert size to number and default to 0 if NaN */
          positionSize += +size || 0
        }
        nextRow++
      }
    }

    if (inProgress && positionSize === 0) {
      this._finishSheet(sheet.title)
      currentSheetTitle = await this._createNewSheet()
      nextRow = 2
      sheet = this._book.find((s) => s.title === currentSheetTitle)
    }

    return {
      sheetTitle: currentSheetTitle,
      inProgress,
      positionSize,
      nextRow,
    }
  }

  async _nextSheet() {
    this._finishSheet(this._sheetTitle)
    const newSheetTitle = await this._createNewSheet()
    const nextRow = 2
    const sheet = this._book.sheetsByTitle[newSheetTitle]

    /* Update this object state */
    this._sheetTitle = newSheetTitle
    this._positionSize = 0
    this._nextRow = nextRow
    this._sheet = sheet

    this._logger.info(
      'Working on current sheet %s, nextRow = %d, positionSize = %f',
      this._sheetTitle,
      this._nextRow,
      this._positionSize
    )
  }

  async setupWorkingSheet() {
    const { sheetTitle, inProgress, positionSize, nextRow } =
      await this._findSheetParameters()
    this._sheetTitle = sheetTitle
    this._positionSize = positionSize
    this._nextRow = nextRow
    this._sheet = this._book.find((s) => s.title === sheetTitle)
  }

  async addRow(inputRow) {
    const nextRow = this._nextRow
    /* XXX nextRow is a zero-based index while _ensureRow accpts a one-based index */
    this._ensureRow(this._sheet, nextRow + 1)
    const prevRow = this._sheet.cells[nextRow - 1]
    const row = this._sheet.cells[nextRow]
    for (let i = 0; i < headerValues.length; i++) {
      switch (i) {
        case 0:
        case 2:
        case 3:
        case 4:
        case 5:
        case 6:
          row[i] = inputRow[i]
          break
        case 1:
          row[i] = inputRow[i].toDate()
          break
        case 7:
          // 0 1 2 3 4 5 6 7
          // A B C D E F G H
          const H = prevRow[7]
          const S = this._sheet.cells
            .slice(1, nextRow)
            .reduce((s, c) => s + c[3], 0.0)
          const Bsp = row[2] === 'Buy' ? row[3] * row[4] : 0.0
          const Bs = row[2] === 'Buy' ? row[3] : 0.0
          row[i] = ((H * S + Bsp) / (S + Bs)).toFixed(8)
          break
        case 8:
          // 0 1 2 3 4 5 6 7
          // A B C D E F G H
          row[i] = row[2] === 'Sell' ? (row[4] - row[7]) * row[3] : 0.0
          break
        case 9:
          // 0 1 2 3 4 5 6 7
          // A B C D E F G H
          row[i] = -Math.abs((row[3] * row[4] * row[6]).toFixed(8))
          break
        case 10:
          // 0 1 2 3 4 5 6 7 8 9 10
          // A B C D E F G H I J  K
          row[i] = row[8] + prevRow[10] + row[9] + row[5]
          break
      }
    }

    this._logger.info(`addRow: ${JSON.stringify(inputRow)}`)
    this._logger.debug('sheet:')
    for (let i = 0; i < this._sheet.length; i++) {
      this._logger.debug(`[${i}] ${JSON.stringify(this._sheet[i])}`)
    }

    this._nextRow++
    this._positionSize += inputRow[3]
    if (this._positionSize === 0) {
      await this._nextSheet()
    }
  }
}

export class GoogleSheetsBackend {
  constructor(walletType, walletCurrency) {
    this._logger = createLogger('gsheetsbackend')
    this._book = new GoogleSpreadsheet(workbookId, jwt)
    this._walletType = walletType
    this._walletCurrency = walletCurrency
  }

  async _getCurrentSheet() {
    const sheet = this._book.sheetsByTitle['Index']
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

  async _finishSheet(sheetTitle) {
    const sheet = this._book.sheetsByTitle['Index']
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

  async _createNewSheet() {
    const indexSheet = this._book.sheetsByTitle['Index']
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
    const balance = await getBalance(this._walletType, this._walletCurrency)
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

  async _getNextRow(sheet) {
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
      await this._finishSheet(sheet.title)
      currentSheetTitle = await this._createNewSheet()
      nextRow = 2
      sheet = this._book.sheetsByTitle[currentSheetTitle]
      await sheet.loadCells()
    }

    return { nextRow, positionSize, sheet }
  }

  async _findSheetParameters() {
    await this._book.loadInfo()
    let currentSheetTitle =
      (await this._getCurrentSheet()) || (await this._createNewSheet())

    let sheet = this._book.sheetsByTitle[currentSheetTitle]
    await sheet.loadCells()

    const {
      nextRow,
      positionSize,
      sheet: newSheet,
    } = await this._getNextRow(sheet)
    if (sheet.title !== newSheet.title) {
      sheet = newSheet
    }

    return {
      sheetTitle: sheet.title,
      inProgress,
      positionSize,
      nextRow,
    }
  }

  async _nextSheet() {
    await this._finishSheet(this._sheetTitle)
    const newSheetTitle = await this._createNewSheet()
    const nextRow = 2
    const sheet = this._book.sheetsByTitle[newSheetTitle]
    await sheet.loadCells()

    /* Update this object state */
    this._sheetTitle = newSheetTitle
    this._positionSize = 0
    this._nextRow = nextRow
    this._sheet = sheet

    this._logger.info(
      'Working on current sheet %s, nextRow = %d, positionSize = %f',
      this._sheetTitle,
      this._nextRow,
      this._positionSize
    )
  }

  async setupWorkingSheet() {
    const { sheetTitle, positionSize, nextRow } =
      await this._findSheetParameters()
    this._sheetTitle = sheetTitle
    this._positionSize = positionSize
    this._nextRow = nextRow
    this._sheet = this._book.sheetsByTitle[sheetTitle]
  }

  async addRow(inputRow) {
    /* Update parameters in case external modificaitons were made to the spreadsheet */
    const {
      nextRow: updatedNextRow,
      positionSize,
      sheet,
    } = await this._getNextRow(this._sheet)
    this._nextRow = updatedNextRow
    this._positionSize = positionSize
    this._sheet = sheet
    this._sheetTitle = sheet.title
    /* ***************************************************************************** */

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

    this._nextRow++
    this._positionSize += inputRow[3]
    if (this._positionSize === 0) {
      await this._nextSheet()
    }
  }
}

export class Gsheet {
  constructor(gsheetApi) {
    this._api = gsheetApi
    this._logger = createLogger('gsheet')
  }

  async setupWorkingSheet() {
    await this._api.setupWorkingSheet()
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
    await this._api.addRow(inputRow)
  }

  async addFunding(funding) {
    const fundingAmount = +(
      this._api._positionSize *
      funding.markPrice *
      funding.funding
    ).toFixed(8)

    this._logger.debug(
      'adding funding: ts=%d nextTs=%d funding=%f markPrice=%f',
      funding.status[0],
      funding.status[7],
      funding.status[11],
      funding.status[14]
    )

    this._logger.debug('calculated funding: %f', fundingAmount)

    if (Number.isFinite(fundingAmount) && fundingAmount !== 0) {
      const inputRow = [
        '',
        dayjs.utc(funding.statusTs),
        'Funding',
        0,
        0,
        fundingAmount,
        0,
      ]
      await this._api.addRow(inputRow)
    }
  }
}
