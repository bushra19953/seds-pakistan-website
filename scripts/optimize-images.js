const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const inputPath = path.join(__dirname, '../src/assets/logo.png');
const outputDir = path.join(__dirname, '../public/assets');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function optimizeLogo() {
  try {
    // Convert to WebP
    await sharp(inputPath)
      .webp({ quality: 80 })
      .toFile(path.join(outputDir, 'logo.webp'));
    console.log('Logo converted to WebP');

    // Convert to AVIF
    await sharp(inputPath)
      .avif({ quality: 70 })
      .toFile(path.join(outputDir, 'logo.avif'));
    console.log('Logo converted to AVIF');

    // Copy original PNG to public/assets as well
    fs.copyFileSync(inputPath, path.join(outputDir, 'logo.png'));
    console.log('Original PNG copied to public/assets');

  } catch (error) {
    console.error('Error optimizing logo:', error);
  }
}

optimizeLogo();