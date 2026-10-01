
const fs = require('fs');

const traceFile = "e:\\Next SEDS\\Trace-20251223T045758.json";
const reportFile = "e:\\Next SEDS\\performance_report.txt";

const durRegex = /"dur":(\d+)/g;

function getDetails(window) {
    // Try to find a URL
    const urlMatch = /"url":"([^"]+)"/.exec(window);
    // Try to find a function name
    const funcMatch = /"functionName":"([^"]+)"/.exec(window);
    // Try to find the name of the event
    const nameMatch = /"name":"([^"]+)"/.exec(window);

    return {
        name: nameMatch ? nameMatch[1] : "Unknown",
        url: urlMatch ? urlMatch[1] : null,
        func: funcMatch ? funcMatch[1] : null
    };
}

const longTasks = [];
const threshold = 50000; // 50ms for "official" LongTasks

let stream = fs.createReadStream(traceFile, { encoding: 'utf8' });
let leftover = "";

stream.on('data', (chunk) => {
    const data = leftover + chunk;
    let match;
    while ((match = durRegex.exec(data)) !== null) {
        const dur = parseInt(match[1]);
        if (dur > threshold) {
            const start = Math.max(0, match.index - 500);
            const end = Math.min(data.length, match.index + 500);
            const window = data.substring(start, end);

            const details = getDetails(window);
            longTasks.push({ ...details, dur_ms: dur / 1000 });
        }
    }
    leftover = data.substring(data.length - 1000);
});

stream.on('end', () => {
    longTasks.sort((a, b) => b.dur_ms - a.dur_ms);

    let output = "Detailed Trace Performance Analysis\n";
    output += "===================================\n\n";
    output += `Found ${longTasks.length} tasks > 50ms.\n\n`;

    longTasks.slice(0, 30).forEach((task, i) => {
        output += `${i + 1}. ${task.name}: ${task.dur_ms.toFixed(2)} ms\n`;
        if (task.url) output += `   URL: ${task.url}\n`;
        if (task.func) output += `   Function: ${task.func}\n`;
        output += "\n";
    });

    fs.writeFileSync(reportFile, output);
});
