#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function updatePackageVersion(packagePath, newVersion) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const oldVersion = packageJson.version;
  packageJson.version = newVersion;
  
  // Update dependencies to the new version if they reference internal packages
  if (packageJson.dependencies) {
    for (const [dep, version] of Object.entries(packageJson.dependencies)) {
      if (dep.startsWith('@sh_michael/')) {
        packageJson.dependencies[dep] = newVersion;
      } else if (typeof version === 'string' && version.includes('@sh_michael/')) {
        // Handle npm aliases like "playwright-core": "npm:@sh_michael/playwright-core@1.56.4"
        const match = version.match(/^npm:(@sh_michael\/[^@]+)@/);
        if (match) {
          packageJson.dependencies[dep] = `npm:${match[1]}@${newVersion}`;
        }
      }
    }
  }
  
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated ${packagePath}: ${oldVersion} -> ${newVersion}`);
}


function main() {
  try {
    // First, increment the version in the root package.json using npm version patch
    console.log('Running npm version patch...');
    execSync('npm version patch --no-git-tag-version', { 
      encoding: 'utf8',
      cwd: process.cwd()
    });
    
    // Get the new version from the root package.json
    const rootPackagePath = path.join(process.cwd(), 'package.json');
    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
    const newVersion = rootPackage.version;
    
    console.log(`New version: ${newVersion}`);
    
    // Packages to exclude from version updates
    const excludedPackages = ['html-reporter', 'playwright-client', 'recorder', 'trace-viewer', 'web'];
    
    // Update all workspace packages (excluding specified ones)
    const packagesDir = path.join(process.cwd(), 'packages');
    const packages = fs.readdirSync(packagesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .filter(pkg => !excludedPackages.includes(pkg));
    
    console.log(`Updating ${packages.length} packages (excluding: ${excludedPackages.join(', ')})...`);
    
    for (const pkg of packages) {
      const packagePath = path.join(packagesDir, pkg, 'package.json');
      if (fs.existsSync(packagePath)) {
        updatePackageVersion(packagePath, newVersion);
      }
    }
    
    console.log('\n✅ Version increment completed successfully!');
    console.log(`All packages updated to version: ${newVersion}`);
    
  } catch (error) {
    console.error('❌ Error during version increment:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { updatePackageVersion };