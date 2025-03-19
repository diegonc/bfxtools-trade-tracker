require('./config')

const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const { JWT } = require('google-auth-library')
const { GoogleSpreadsheet } = require('google-spreadsheet')

dayjs.extend(utc)

const { getWallets, subscribeTrades, ledgers } = require('./bitfinex-utils')
const { DateToValue } = require('./gsheets-date-utils')
const credentials = require(process.env.GOOGLE_ACCOUNT_JSON_FILE)
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

async function getCurrentSheet(book) {
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

async function finishSheet(book, sheetTitle) {
  const sheet = book.sheetsByTitle['Index']
  const count = sheet.rowCount
  const rows = await sheet.getRows({ offset: 0, limit: count })
  for (const row of rows) {
    const title = row.get('Sheet Title')
    if (title === sheetTitle) {
      row.set('Status', 'DONE')
      row.save()
      break
    }
  }
}

async function createNewSheet(book, walletType, walletCurrency) {
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
  dateCell.numberFormat = { type: 'DATE_TIME', pattern: 'yyyy/mm/dd hh:mm:ss' }
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

async function getBalance(type, currency) {
  const entries = (await ledgers({ filters: { ccy: currency } }))
    .filter((l) => l[2] === type && l[1] === currency)
    .sort((a, b) => b[3] - a[3] || b[0] - a[0])

  if (entries.length > 0) {
    return entries[0][6]
  } else {
    /* Fallback to balance info (imprecise) */
    const wallets = await getWallets().filter(
      (wallet) =>
        wallet.type.toLowerCase() === walletType.toLowerCase() &&
        wallet.currency.toLowerCase() === walletCurrency.toLowerCase()
    )
    if (wallets.length > 1) {
      throw new Error('[INFO] getBalance - duplicated (type, currency) pair')
    }
    return wallets[0][2]
  }
}

async function setupWorkingSheet(walletType, walletCurrency) {
  const book = new GoogleSpreadsheet(workbookId, jwt)
  await book.loadInfo()

  let currentSheetTitle =
    (await getCurrentSheet(book)) ||
    (await createNewSheet(book, walletType, walletCurrency))

  let sheet = book.sheetsByTitle[currentSheetTitle]
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
    await finishSheet(book, currentSheetTitle)
    currentSheetTitle = await createNewSheet(book, walletType, walletCurrency)
    nextRow = 2
    sheet = book.sheetsByTitle[currentSheetTitle]
    await sheet.loadCells()
  }

  return {
    sheetTitle: currentSheetTitle,
    positionSize,
    nextRow,
    sheet,
    async _nextSheet() {
      await finishSheet(book, currentSheetTitle)
      const newSheetTitle = await createNewSheet(
        book,
        walletType,
        walletCurrency
      )
      const nextRow = 2
      const sheet = book.sheetsByTitle[currentSheetTitle]
      await sheet.loadCells()

      /* Update this object state */
      this.sheetTitle = newSheetTitle
      this.positionSize = 0
      this.nextRow = nextRow
      this.sheet = sheet

      console.log(
        `Working on current sheet ${this.sheetTitle}, nextRow = ${this.nextRow}, positionSize = ${this.positionSize}`
      )
    },
    async _addFirstRow(trade) {
      const fee = trade.fee / (trade.execAmount * trade.execPrice)
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

      for (let i = 0; i < headerValues.length; i++) {
        const cell = this.sheet.getCell(this.nextRow, i)
        cell.backgroundColor = readOnlyColor
        switch (i) {
          case 0:
            cell.numberValue = inputRow[i]
            break
          case 1:
            cell.numberFormat = {
              type: 'DATE_TIME',
              pattern: 'yyyy/mm/dd hh:mm:ss',
            }
            cell.numberValue = DateToValue(dayjs.utc(inputRow[i]).toDate())
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
            cell.formula = '=ROUNDUP(E3;8)'
            break
          case 8:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#0.00000000',
            }
            cell.formula = `=IF(C3="Sell";(E3-H3)*D3;0)`
            break
          case 9:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#0.00000000',
            }
            cell.formula = `=-ABS(ROUND(D3*E3*G3;8))`
            break
          case 10:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#0.00000000',
            }
            cell.formula = `=I3+K2+J3+F3`
            break
        }
      }
      await this.sheet.saveUpdatedCells()
      this.nextRow++
      this.positionSize += -trade.execAmount
    },
    async addTrade(trade) {
      if (this.nextRow === 2) {
        return this._addFirstRow(trade)
      }

      const fee = trade.fee / (trade.execAmount * trade.execPrice)
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

      for (let i = 0; i < headerValues.length; i++) {
        const cell = this.sheet.getCell(this.nextRow, i)
        if (i > 6) {
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
            cell.numberValue = DateToValue(dayjs.utc(inputRow[i]).toDate())
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
            cell.formula = `=ROUNDUP((H${nextRow}*SUM($D$3:D${nextRow})+IF(C${
              nextRow + 1
            }="Buy";(D${nextRow + 1}*E${
              nextRow + 1
            });0))/(SUM($D$3:D${nextRow})+IF(C${nextRow + 1}="Buy";D${
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
      await this.sheet.saveUpdatedCells()
      this.nextRow++
      this.positionSize += -trade.execAmount
      if (this.positionSize === 0) {
        await this._nextSheet()
      }
    },
    async addFunding(funding) {
      const inputRow = [
        '',
        dayjs.utc(funding.ts),
        'Funding',
        0,
        0,
        funding.funding,
        0,
      ]

      for (let i = 0; i < headerValues.length; i++) {
        const cell = this.sheet.getCell(this.nextRow, i)
        if (i > 6) {
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
            cell.numberValue = DateToValue(dayjs.utc(inputRow[i]).toDate())
            break
          case 2:
            cell.stringValue = inputRow[i]
            break
          case 3:
          case 4:
          case 5:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.00000000',
            }
            cell.numberValue = inputRow[i]
            break
          case 6:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.000%',
            }
            cell.numberValue = inputRow[i]
            break
          case 7:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.00000000',
            }
            cell.formula = `=ROUNDUP((H${nextRow}*SUM($D$3:D${nextRow})+IF(C${
              nextRow + 1
            }="Buy";(D${nextRow + 1}*E${
              nextRow + 1
            });0))/(SUM($D$3:D${nextRow})+IF(C${nextRow + 1}="Buy";D${
              nextRow + 1
            };0));8)`
            break
          case 8:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.00000000',
            }
            cell.formula = `=IF(C${nextRow + 1}="Sell";(E${nextRow + 1}-H${
              nextRow + 1
            })*D${nextRow + 1};0)`
            break
          case 9:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.00000000',
            }
            cell.formula = `=-ABS(ROUND(D${nextRow + 1}*E${nextRow + 1}*G${
              nextRow + 1
            };8))`
            break
          case 10:
            cell.numberFormat = {
              type: 'NUMBER',
              pattern: '#.00000000',
            }
            cell.formula = `=I${nextRow + 1}+K${nextRow}+J${nextRow + 1}+F${
              nextRow + 1
            }`
            break
        }
      }
      await this.sheet.saveUpdatedCells()
    },
  }
}

async function main(symbol, walletCurrency) {
  const tracker = await setupWorkingSheet('margin', walletCurrency)
  console.log(
    `Working on current sheet ${tracker.sheetTitle}, nextRow = ${tracker.nextRow}, positionSize = ${tracker.positionSize}`
  )

  const { close } = await subscribeTrades(
    { symbol, statusKey: `deriv:${symbol}` },
    (trade) => {
      const fee = trade.fee / (trade.execAmount * trade.execPrice)
      const type = -trade.execAmount < 0 ? 'Buy' : 'Sell'

      console.log('trade', JSON.stringify(trade, null, 2))
      console.log('fee %', fee)
      console.log(
        [
          trade.id,
          dayjs.utc(trade.mts),
          type,
          -trade.execAmount,
          trade.execPrice,
          '',
          fee,
        ].join(',')
      )

      tracker
        .addTrade(trade)
        .catch((err) => console.log('main :: addTrade', err))
    },
    (status) => {
      console.log(
        'status',
        JSON.stringify({ positionSize: tracker.positionSize, status })
      )
      if (tracker.positionSize !== 0) {
        console.log(['Funding', JSON.stringify(status.funding)].join(' '))
        if (!!status.funding) {
          tracker
            .addFunding(status)
            .catch((err) => console.log('main :: addFunding', err))
        }
      }
    }
  )

  function term() {
    console.log('Closing WS connection...')
    close().then((_) => {
      console.log('Exiting...')
      process.exit(0)
    })
  }

  process.on('SIGINT', term)
  process.on('SIGTERM', term)
}

const arg = process.argv[2] || 'track'
if (arg === 'balance') {
  const type = process.argv[3]
  const currency = process.argv[4]
  if (!type || !currency) {
    console.log('Usage: program balance [type] [currency]')
    return
  }
  getBalance(type, currency)
    .then((balance) => console.log('Balance:', balance))
    .catch((err) => console.log('balance :: error', err))
} else if (arg === 'ledgers') {
  const currency = process.argv[3]
  if (!currency) {
    console.log('Usage: program ledgers [currency]')
    return
  }
  ledgers({ filters: { ccy: currency } }).then(
    (_ledgers) =>
      console.log(
        JSON.stringify(
          _ledgers
            .filter((l) => l[2] === 'margin' && l[1] === currency)
            .sort((a, b) => b[3] - a[3] || b[0] - a[0]),
          null,
          2
        )
      ),
    console.error
  )
} else if (arg === 'track') {
  const pair = process.argv[3] || 'tBTCF0:USTF0'
  const ccy = process.argv[4] || 'USTF0'
  main(pair, ccy).catch((err) => console.log('main :: error', err))
} else {
  console.log(
    `
    Usage: program [balance|ledgers|track]
    
      balance type currency   Get balance of the currency 
                              <currency> in the wallet <type>.

      ledgers currency        Get the ledger entries of the currency
                              <currency> in reverse chronological order.
                              The wallet is hardcoded to 'margin'.

      [track pair currency]   Run trade tracking process for the
                              given pair and base currency.
                              If they are not provided the defaults are
                              'tBTCF0:USTF0' for pair and 'USTF0' for
                              currency.
  `.trim()
  )
}
