const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const dist = path.join(root, 'dist');
const bundle = path.join(dist, 'PetLink.app');
if (process.platform !== 'darwin') throw new Error('请在 macOS 上构建。');
if (!fs.existsSync(path.join(root, 'node_modules/electron/dist/Electron.app'))) throw new Error('请先运行 npm install 和 npx install-electron。');
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(bundle, { recursive: true, force: true });
execFileSync('ditto', [path.join(root, 'node_modules/electron/dist/Electron.app'), bundle]);
const info = path.join(bundle, 'Contents/Info.plist');
for (const [key, value] of Object.entries({ CFBundleIdentifier: 'app.petlink.mac', CFBundleName: 'PetLink', CFBundleDisplayName: 'PetLink',
  CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version, NSHumanReadableCopyright: 'PetLink · MIT' })) {
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, info], { stdio: 'ignore' }); }
  catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, info]); }
}
if (fs.existsSync(path.join(root, 'ui/icon.png'))) {
  const iconset = path.join(dist, 'petlink.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const actual = size * scale;
    execFileSync('sips', ['-z', String(actual), String(actual), path.join(root, 'ui/icon.png'), '--out',
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(bundle, 'Contents/Resources/electron.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
}
const appDir = path.join(bundle, 'Contents/Resources/app');
fs.mkdirSync(appDir, { recursive: true });
for (const folder of ['src', 'ui']) fs.cpSync(path.join(root, folder), path.join(appDir, folder), { recursive: true });
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version,
  main: pkg.main, description: pkg.description, license: pkg.license, dependencies: pkg.dependencies }, null, 2));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit' });
for (const file of ['LICENSE', 'README.md']) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(appDir, file));
execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
const archive = path.join(dist, `PetLink-${pkg.version}-mac-arm64.zip`);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive]);
const staging = path.join(dist, 'dmg-stage');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging); fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
execFileSync('ditto', [bundle, path.join(staging, 'PetLink.app')]);
const dmg = path.join(dist, `PetLink-${pkg.version}-mac-arm64.dmg`);
execFileSync('hdiutil', ['create', '-volname', 'PetLink', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
fs.rmSync(staging, { recursive: true, force: true });
console.log(`Built ${bundle}\n${dmg}\n${archive}`);
