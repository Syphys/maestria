import fs from 'fs';
import webpackPaths from '../.erb/configs/webpack.paths';
import path from 'path';

const { releasePath, rootPath } = webpackPaths;

/**
 * Remove a path that may be a file, symlink, broken symlink, or junction.
 * `fs.existsSync` is intentionally not used: it returns false for broken
 * symlinks, leaving them in place and causing EEXIST on the next symlinkSync.
 * Returns true if something was removed, false if the path didn't exist.
 */
function removeIfPresent(target: string): boolean {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code === 'EPERM' || code === 'EISDIR') {
      // Directory or Windows junction — needs rmdirSync.
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

// Link extensions
const srcExt = path.join(releasePath, 'app/node_modules/@tagspaces/extensions');
const targetExt = path.join(rootPath, 'public/modules/@tagspaces/extensions');
removeIfPresent(targetExt);
if (fs.existsSync(srcExt)) {
  fs.symlinkSync(srcExt, targetExt, 'junction');
}

// link Pro extensions
const srcProExt = path.join(
  releasePath,
  'app/node_modules/@tagspacespro/extensions',
);
const targetProExt = path.join(
  rootPath,
  'public/modules/@tagspacespro/extensions',
);
removeIfPresent(targetProExt);
if (fs.existsSync(srcProExt)) {
  fs.symlinkSync(srcProExt, targetProExt, 'junction');
}
