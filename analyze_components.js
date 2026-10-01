
const fs = require('fs');

const traceFile = "e:\\Next SEDS\\Trace-20251223T045758.json";
const reportFile = "e:\\Next SEDS\\component_performance.txt";

// Search for any strings that look like React component tags or names
// Standard React profiles use "⚛" or names like "MyComponent [mount]"
const componentRegex = /"name":"(⚛ [^"]+|[^"]+ \[(mount|update)\]|\[root\])"/g;

const componentDurs = new Map();

let stream = fs.createReadStream(traceFile, { encoding: 'utf8' });
let leftover = "";

console.log("Searching for React component markers...");

stream.on('data', (chunk) => {
    const data = leftover + chunk;
    let match;

    while ((match = componentRegex.exec(data)) !== null) {
        const name = match[1];
        const start = Math.max(0, match.index - 100);
        const end = Math.min(data.length, match.index + 500);
        const window = data.substring(start, end);

        const durMatch = /"dur":(\d+)/.exec(window);
        if (durMatch) {
            const dur = parseInt(durMatch[1]) / 1000; // to ms
            if (!componentDurs.has(name)) {
                componentDurs.set(name, { total: 0, count: 0, max: 0 });
            }
            const stats = componentDurs.get(name);
            stats.total += dur;
            stats.count += 1;
            stats.max = Math.max(stats.max, dur);
        }
    }
    leftover = data.substring(data.length - 1000);
});

stream.on('end', () => {
    const sorted = Array.from(componentDurs.entries())
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.total - a.total);

    let output = "React Component Performance Breakdown\n";
    output += "====================================\n\n";

    if (sorted.length === 0) {
        output += "No specific React component markers found.\n";
        output += "(Note: This happens if the trace wasn't recorded with React DevTools active or 'User Timing' enabled.)\n";

        // Alternative: Let's search for just ANY frequent function names in "name" field
        output += "\nWill perform a broader search for high-frequency event names...\n";
    } else {
        output += "Top Components by Total Render Time:\n";
        sorted.slice(0, 50).forEach((item, i) => {
            output += `${i + 1}. ${item.name}\n`;
            output += `   Total: ${item.total.toFixed(2)} ms | Count: ${item.count} | Max: ${item.max.toFixed(2)} ms\n\n`;
        });
    }

    fs.writeFileSync(reportFile, output);
    console.log("Done.");
});
