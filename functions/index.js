const { initializeApp } = require('firebase-admin/app');
initializeApp();

exports.scout          = require('./scout').scout;
exports.analyst        = require('./analyst').analyst;
exports.matcher        = require('./matcher').matcher;
exports.notifier       = require('./notifier').notifier;
exports.parseUrl       = require('./analyst').parseUrl;

// New Post-MVP Features
exports.whatsappDigest = require('./whatsapp_digest').whatsappDigest;
exports.essayAssist    = require('./essay_assist').essayAssist;
exports.adminProcess   = require('./admin_config').adminProcess;
