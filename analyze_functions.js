
const fs = require('fs');

const traceFile = "e:\\Next SEDS\\Trace-20251223T045758.json";
const reportFile = "e:\\Next SEDS\\function_performance.txt";

const funcNameRegex = /"functionName":"([^"]+)"/g;
const urlRegex = /"url":"([^"]+)"/g;

const functionStats = new Map();
const urlStats = new Map();

let stream = fs.createReadStream(traceFile, { encoding: 'utf8' });
let leftover = "";

console.log("Analyzing function and script performance...");

stream.on('data', (chunk) => {
    const data = leftover + chunk;

    // Search for functionName and duration nearby
    let match;
    while ((match = funcNameRegex.exec(data)) !== null) {
        const name = match[1];
        const start = Math.max(0, match.index - 100);
        const end = Math.min(data.length, match.index + 500);
        const window = data.substring(start, end);

        const durMatch = /"dur":(\d+)/.exec(window);
        if (durMatch) {
            const dur = parseInt(durMatch[1]) / 1000;
            if (!functionStats.has(name)) functionStats.set(name, { total: 0, count: 0 });
            functionStats.get(name).total += dur;
            functionStats.get(name).count += 1;
        }
    }

    // Search for URL and duration nearby
    while ((match = urlRegex.exec(data)) !== null) {
        let url = match[1];
        // Clean up Next.js chunks for better readability
        if (url.includes('chunks/')) {
            const parts = url.split('chunks/');
            url = parts[parts.length - 1];
        }

        const start = Math.max(0, match.index - 100);
        const end = Math.min(data.length, match.index + 500);
        const window = data.substring(start, end);

        const durMatch = /"dur":(\d+)/.exec(window);
        if (durMatch) {
            const dur = parseInt(durMatch[1]) / 1000;
            if (!urlStats.has(url)) urlStats.set(url, { total: 0, count: 0 });
            urlStats.get(url).total += dur;
            urlStats.get(url).count += 1;
        }
    }

    leftover = data.substring(data.length - 1000);
});

stream.on('end', () => {
    const sortedFuncs = Array.from(functionStats.entries())
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.total - a.total);

    const sortedUrls = Array.from(urlStats.entries())
        .map(([url, stats]) => ({ url, ...stats }))
        .sort((a, b) => b.total - a.total);

    let output = "Performance Deep Dive\n";
    output += "=====================\n\n";

    output += "Top Functions by Time:\n";
    sortedFuncs.slice(0, 30).forEach((item, i) => {
        output += `${i + 1}. ${item.name}: ${item.total.toFixed(2)} ms (${item.count} calls)\n`;
    });

    output += "\nTop Scripts by Time:\n";
    sortedUrls.slice(0, 30).forEach((item, i) => {
        output += `${i + 1}. ${item.url}: ${item.total.toFixed(2)} ms (${item.count} calls)\n`;
    });

    fs.writeFileSync(reportFile, output);
    console.log("Done.");
});
