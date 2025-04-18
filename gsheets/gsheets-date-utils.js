/**
 * @param {Number} GoogleDateValue - Days passed since dec 30 1899, time in fraction
 * @returns {Date object} - javascript date object
 *
 */
export function ValueToDate(GoogleDateValue) {
  return new Date(
    new Date(1899, 11, 30 + Math.floor(GoogleDateValue), 0, 0, 0, 0).getTime() +
      (GoogleDateValue % 1) * 86400000
  )
}

/**
 * @param {Date object} - javascript date object{Number}
 * @returns {Number} GoogleDateValue - Days passed since dec 30 1899, time in fraction
 *
 */

export function DateToValue(date) {
  return 25569 + (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000
}
