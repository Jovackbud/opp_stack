const { initializeApp } = require('firebase-admin/app');
initializeApp();

exports.scout    = require('./scout').scout;       // scheduled: every day 07:00 WAT
exports.analyst  = require('./analyst').analyst;   // firestore trigger: on new opportunity
exports.matcher  = require('./matcher').matcher;   // firestore trigger: on new opportunity
exports.notifier = require('./notifier').notifier; // scheduled: every day 08:00 WAT
exports.parseUrl = require('./analyst').parseUrl;  // callable: on-demand URL parse (upload flow)
