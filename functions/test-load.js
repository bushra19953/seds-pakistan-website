// test-load.js
console.time('Full Cold Start Load Time');

const startTimestamp = Date.now();
console.log(`[${new Date().toISOString()}] 🚀 FORCING COLD START EMULATION: Loading index.js...`);

try {
  // Simulate the exact require path Firebase uses
  const functions = require('./lib/index.js');
  
  const endTimestamp = Date.now();
  const duration = endTimestamp - startTimestamp;
  
  console.log(`[${new Date().toISOString()}] ✅ SUCCESS: index.js loaded in ${duration}ms`);
  console.timeEnd('Full Cold Start Load Time');
  
  console.log('\n--- Exported Triggers ---');
  console.log(Object.keys(functions).join('\n'));
  
  if (duration >= 10000) {
    console.error(`\n❌ APOCALYPSE DETECTED: Initialization took ${duration}ms (LIMIT IS 10000ms). Firebase will kill this.`);
    process.exit(1);
  } else {
    console.log(`\n✅ SAFE: Initialization is under the 10000ms threshold.`);
  }

} catch (error) {
  console.error(`\n❌ CRASH: Failed to load index.js`);
  console.error(error);
  process.exit(1);
}
