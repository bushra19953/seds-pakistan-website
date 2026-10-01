
import json
import re

trace_file = r"e:\Next SEDS\Trace-20251223T045758.json"

# Regex to find duration and name without loading whole JSON
# Looks for "dur":12345 and "name":"Something"
dur_regex = re.compile(r'"dur":(\d+)')
name_regex = re.compile(r'"name":"([^"]+)"')

long_tasks = []

print(f"Scanning {trace_file} for long tasks...")

with open(trace_file, 'r', encoding='utf-8') as f:
    # We'll read in chunks to handle the 350MB file efficiently
    chunk_size = 1024 * 1024 # 1MB
    leftover = ""
    
    while True:
        chunk = f.read(chunk_size)
        if not chunk:
            break
        
        # Combine with leftover from last chunk to catch split entries
        data = leftover + chunk
        
        # Find all occurrences of "dur": followed by a number
        # and search for the closest name nearby
        # This is a bit "fuzzy" but very fast
        start_pos = 0
        while True:
            match = dur_regex.search(data, start_pos)
            if not match:
                # Save the tail of the chunk as leftover
                leftover = data[max(0, len(data)-1000):]
                break
            
            dur = int(match.group(1))
            
            # Threshold: > 50ms (50,000 microseconds)
            if dur > 50000:
                # Look backwards or forwards to find the name in the same JSON object
                # For simplicity, we'll just grab a window around the match
                start = max(0, match.start() - 200)
                end = min(len(data), match.end() + 200)
                window = data[start:end]
                
                name_match = name_regex.search(window)
                name = name_match.group(1) if name_match else "Unknown"
                
                long_tasks.append({'name': name, 'dur_ms': dur / 1000, 'pos': match.start()})
            
            start_pos = match.end()

# Sort by duration descending
long_tasks.sort(key=lambda x: x['dur_ms'], reverse=True)

print("\nTop 10 Longest Tasks Found:")
for task in long_tasks[:10]:
    print(f"- {task['name']}: {task['dur_ms']:.2f} ms")

if not long_tasks:
    print("No tasks longer than 50ms found.")
