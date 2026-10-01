const fs = require('fs');
const path = require('path');

const TARGET_IMPORTS = ['setDoc', 'updateDoc', 'addDoc', 'deleteDoc'];
const TARGET_FILE_EXTS = ['.ts', '.tsx'];
const EXCLUDE_FILES = ['firestore-wrapper.ts'];

function processFile(filePath) {
  if (EXCLUDE_FILES.includes(path.basename(filePath))) return;

  const content = fs.readFileSync(filePath, 'utf8');
  
  // Regex to match: import { ... } from 'firebase/firestore'
  const importRegex = /import\s+\{([\s\S]*?)\}\s+from\s+['"]firebase\/firestore['"]/g;
  
  let newContent = content;
  let matchesFound = false;
  let wrapperImportsNeeded = new Set();
  
  newContent = newContent.replace(importRegex, (match, importsStr) => {
    // Split by comma, handling potential newlines and spaces
    const individualImports = importsStr.split(',').map(i => i.trim()).filter(i => i);
    
    const remainingImports = [];
    
    for (const imp of individualImports) {
      // Check if it's an alias e.g., "setDoc as mySetDoc"
      const baseImportName = imp.split(' as ')[0].trim();
      
      if (TARGET_IMPORTS.includes(baseImportName)) {
        matchesFound = true;
        wrapperImportsNeeded.add(imp); // Keep aliases intact for the wrapper import
      } else {
        remainingImports.push(imp);
      }
    }
    
    if (wrapperImportsNeeded.size === 0) {
      return match; // No changes needed for this import block
    }
    
    // Reconstruct the original import if there are remaining imports
    let replacement = '';
    if (remainingImports.length > 0) {
      replacement = `import { ${remainingImports.join(', ')} } from 'firebase/firestore';\n`;
    }
    
    return replacement;
  });
  
  if (matchesFound) {
    // Add the new wrapper import at the top of the file, after the last import if possible, or just at the top
    const wrapperImportStr = `import { ${Array.from(wrapperImportsNeeded).join(', ')} } from '@/lib/client/firestore-wrapper';\n`;
    
    // Find the last import statement to insert after, or just at the beginning
    const lastImportMatch = [...newContent.matchAll(/^import.*from.*$/gm)].pop();
    
    if (lastImportMatch) {
      const insertIndex = lastImportMatch.index + lastImportMatch[0].length;
      newContent = newContent.slice(0, insertIndex) + '\n' + wrapperImportStr + newContent.slice(insertIndex);
    } else {
      newContent = wrapperImportStr + newContent;
    }
    
    // Clean up potential double newlines added by manipulation
    newContent = newContent.replace(/\n{3,}/g, '\n\n');
    
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Updated: ${filePath}`);
    return true;
  }
  return false;
}

function walkDir(dir, callback) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.next') {
        walkDir(filePath, callback);
      }
    } else if (TARGET_FILE_EXTS.includes(path.extname(filePath))) {
      callback(filePath);
    }
  }
}

const targetDir = path.join(__dirname, '..', 'src');
let updatedCount = 0;

console.log(`Scanning ${targetDir} for firestore imports...`);
walkDir(targetDir, (filePath) => {
  if (processFile(filePath)) {
    updatedCount++;
  }
});

console.log(`\nFinished! Updated ${updatedCount} files.`);
