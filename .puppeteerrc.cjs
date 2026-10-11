const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Store the downloaded Chrome binary inside the local project folder
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};