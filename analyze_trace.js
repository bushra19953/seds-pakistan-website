
const fs = require('fs');

const traceFile = "e:\\Next SEDS\\Trace-20251223T045758.json";
const durRegex = /"dur":(\d+)/g;
const nameRegex = /"name":"([^"]+)"/;

const longTasks = [];
const threshold = 50000; // 50ms

console.log(`Scanning ${traceFile} for long tasks...`);

const readable = fs.createReadStream(traceFile, { encoding: 'utf8', highWaterMark: 1024 * 1024 });

let leftover = "";

readable.on('data', (chunk) => {
    const data = leftover + chunk;
    let match;

    // We need to reset the regex lastIndex if we were using it for search, 
    // but here we just find all in the current data.
    while ((match = durRegex.exec(data)) !== null) {
        const dur = parseInt(match[1]);

        if (dur > threshold) {
            const start = Math.max(0, match.index - 200);
            const end = Math.min(data.length, match.index + 200);
            const window = data.substring(start, end);

            const nameMatch = nameRegex.exec(window);
            const name = nameMatch ? nameMatch[1] : "Unknown";

            longTasks.push({ name, dur_ms: dur / 1000 });
        }
    }

    // Keep the last bit to avoid splitting matches
    leftover = data.substring(data.length - 1000);
});

readable.on('end', () => {
    longTasks.sort((a, b) => b.dur_ms - a.dur_ms);

    console.log("\nTop 10 Longest Tasks Found:");
    longTasks.slice(0, 10).forEach(task => {
        console.log(`- ${task.name}: ${task.dur_ms.toFixed(2)} ms`);
    });

    if (longTasks.length === 0) {
        console.log("No tasks longer than 50ms found.");
    }
});
