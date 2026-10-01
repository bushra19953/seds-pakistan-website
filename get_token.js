const admin = require('firebase-admin');
const fs = require('fs');

const serviceAccount = JSON.parse(fs.readFileSync('e:\\SEDS WEBSITE UPDATED SHIT\\seds-pakistan-service-account.json', 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

admin.credential.cert(serviceAccount).getAccessToken().then(token => {
  console.log(token.access_token);
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
