import fs from 'fs';
import webpackPaths from '../configs/webpack.paths';
import path from 'path';

const {
  srcNodeModulesPath,
  appNodeModulesPath,
  erbPath,
  erbNodeModulesPath,
  appPath,
  srcPath,
  distPath,
} = webpackPaths;

/**
 * Remove a path that may be a file, symlink, broken symlink, or junction.
 * `fs.existsSync` is intentionally not used: it returns false for broken
 * symlinks, leaving them in place and causing EEXIST on the next symlinkSync.
 */
function removeIfPresent(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code === 'EPERM' || code === 'EISDIR') {
      try {
        fs.rmdirSync(target);
        return true;
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === 'ENOENT') return false;
        console.error('Error removing ' + target, err2);
        return false;
      }
    }
    console.error('Error removing ' + target, err);
    return false;
  }
}

removeIfPresent(srcNodeModulesPath);
if (fs.existsSync(appNodeModulesPath)) {
  fs.symlinkSync(appNodeModulesPath, srcNodeModulesPath, 'junction');
}

removeIfPresent(erbNodeModulesPath);
if (fs.existsSync(appNodeModulesPath)) {
  fs.symlinkSync(appNodeModulesPath, erbNodeModulesPath, 'junction');
}

const targetNodeModules = path.join(distPath, 'node_modules');
removeIfPresent(targetNodeModules);
if (fs.existsSync(appNodeModulesPath)) {
  try {
    fs.symlinkSync(appNodeModulesPath, targetNodeModules, 'junction');
  } catch (err) {
    console.error(
      'Error creating link target:' +
        targetNodeModules +
        ':' +
        (err as Error).message,
    );
  }
}

////////link .env
const targetEnv = path.join(erbPath, '.env'); //srcPath, '.env');
const appEnv = path.join(appPath, '.env');

removeIfPresent(targetEnv);
if (fs.existsSync(appEnv)) {
  try {
    fs.symlinkSync(appEnv, targetEnv, 'file');
  } catch (e) {
    console.log(targetEnv + ' could not be linked: ' + (e as Error).message);
  }
}

const distEnv = path.join(distPath, '.env');
removeIfPresent(distEnv);
if (fs.existsSync(appEnv)) {
  try {
    fs.symlinkSync(appEnv, distEnv, 'file');
  } catch (e) {
    console.log(distEnv + ' could not be linked: ' + (e as Error).message);
  }
}
