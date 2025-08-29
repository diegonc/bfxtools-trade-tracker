import './config/index.js'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { RetryableQueue } from './queue'

dayjs.extend(utc)

import {
  BFXApi,
  getBalance,
  subscribeTrades,
  ledgers,
} from './bitfinex-utils.js'

import createLogger from './logging.js'
import { GoogleSheetsBackend, Gsheet, MemoryBackend } from './gsheets/index.js'

const logger = createLogger('main')
const queue = new RetryableQueue({ concurrency: 1 })

function handleOnTrade(tracker, trade) {
  return async function () {
    const fee = Math.abs(trade.fee / (trade.execAmount * trade.execPrice))
    const type = -trade.execAmount < 0 ? 'Buy' : 'Sell'

    logger.info(
      '%s - amount=%f, price=%f, fee=%f',
      type,
      -trade.execAmount,
      trade.execPrice,
      fee
    )

    try {
      return tracker.addTrade(trade)
    } catch (err) {
      logger.error(`addTrade :: ${err.message}`, err)
      throw err
    }
  }
}

function handleOnStatus(tracker, status) {
  return async function () {
    if (tracker._api._positionSize !== 0) {
      if (!!status.funding) {
        try {
          logger.info(
            'Funding - [ts=%d nextTs=%d] %f',
            status.statusTs,
            status.nextTs,
            +(
              tracker._api._positionSize *
              status.markPrice *
              status.funding
            ).toFixed(8)
          )
          return tracker.addFunding(status)
        } catch (err) {
          logger.error(`addFunding :: ${err.message}`, err)
          throw err
        }
      }
    }
  }
}

async function main(symbol, walletCurrency) {
  const tracker = new Gsheet(
    new GoogleSheetsBackend('margin', walletCurrency, BFXApi)
  )
  await tracker.setupWorkingSheet()
  logger.info(
    'Working on current sheet %s, nextRow = %d, positionSize = %f',
    tracker._api._sheetTitle,
    tracker._api._nextRow,
    tracker._api._positionSize
  )

  const { close } = await subscribeTrades(
    { symbol, statusKey: `deriv:${symbol}` },
    (trade) => {
      queue
        .addRetryableTask(handleOnTrade(tracker, trade))
        .catch((err) =>
          logger.error(`onTrade :: all retries failed: ${err.message}`, err)
        )
    },
    (status) => {
      queue
        .addRetryableTask(handleOnStatus(tracker, status))
        .catch((err) =>
          logger.error(`onStatus :: all retries failed: ${err.message}`, err)
        )
    }
  )

  function term() {
    logger.debug('Closing WS connection...')
    close().then((_) => {
      logger.debug('Exiting...')
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
    process.exit(1)
  }
  getBalance(type, currency)
    .then((balance) => console.log('Balance:', balance))
    .catch((err) => console.log('balance :: error', err))
} else if (arg === 'ledgers') {
  const currency = process.argv[3]
  if (!currency) {
    console.log('Usage: program ledgers [currency]')
    process.exit(1)
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
  /* test pair : 'tTESTBTCF0:TESTUSDTF0' */
  const pair = process.argv[3] || 'tBTCF0:USTF0'
  /* test ccy : 'TESTUSDTF0' */
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
