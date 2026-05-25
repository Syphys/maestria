/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';
import { BrowserWindow } from 'electron';
import { execFile } from 'child_process';
import http from 'http';
import settings from './settings';

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    const port = process.env.PORT || 1212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
}

/**
 * @param payload: string
 * @param endpoint: string
 * @param signal
 */
export function postRequest(payload, endpoint, signal = undefined) {
  return isWorkerAvailable().then((workerAvailable) => {
    if (!workerAvailable) {
      return Promise.reject(new Error('no Worker Available!'));
    }

    return new Promise((resolve, reject) => {
      // quick abort check
      if (signal && signal.aborted) {
        const e = new Error('Aborted before sending');
        e.name = 'AbortError';
        return reject(e);
      }

      let settled = false; // ensure we resolve/reject only once
      let respRef = null; // keep response to remove listeners on cleanup

      const options = {
        hostname: '127.0.0.1',
        port: settings.getUsedWsPort(),
        method: 'POST',
        path: endpoint,
        headers: {
          Authorization: 'Bearer ' + settings.getToken(),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
        },
      };
      const reqPost = http.request(options, (resp) => {
        respRef = resp;
        let data = '';

        const onData = (chunk) => {
          data += chunk;
        };

        // The whole response has been received. Print out the result.
        const onEnd = () => {
          if (settled) return;
          settled = true;
          cleanup();
          if (data) {
            try {
              resolve(JSON.parse(data));
            } catch (ex) {
              reject(ex);
            }
          } else {
            reject(new Error('Error: no data'));
          }
        };

        const onRespError = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        resp.on('data', onData);
        resp.on('end', onEnd);
        resp.on('error', onRespError);
      });

      // handle request-level errors
      const onReqError = (err) => {
        if (settled) return;
        // If the signal caused abort, we'll already reject from the abort handler.
        // But http.request abort may also emit an 'error' (ECONNRESET). If signal was aborted,
        // map this to AbortError for consistency.
        if (signal && signal.aborted) {
          const e = new Error('Request aborted');
          e.name = 'AbortError';
          settled = true;
          cleanup();
          return reject(e);
        }
        settled = true;
        cleanup();
        reject(err);
      };

      reqPost.on('error', onReqError);

      // cleanup removes listeners
      const cleanup = () => {
        if (signal && typeof signal.removeEventListener === 'function') {
          try {
            signal.removeEventListener('abort', onSignalAbort);
          } catch (ex) {}
        }
        reqPost.removeListener('error', onReqError);
        if (respRef) {
          respRef.removeAllListeners('data');
          respRef.removeAllListeners('end');
          respRef.removeAllListeners('error');
        }
      };

      // abort handler
      const onSignalAbort = () => {
        if (settled) return;
        // mark settled first to avoid race with req 'error' emission
        settled = true;
        cleanup();

        // destroy/abort the underlying request. We don't pass an Error here
        // because it may synchronously emit 'error' events that could be
        // reentrant; we've already set settled and removed listeners.
        try {
          reqPost.destroy();
        } catch (ex) {
          /* ignore */
        }

        const abortErr = new Error('Request aborted by signal');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };

      // attach abort listener once
      if (signal && typeof signal.addEventListener === 'function') {
        // use { once: true } so handler runs only once
        signal.addEventListener('abort', onSignalAbort, { once: true });
      }

      // send payload
      try {
        reqPost.write(payload);
        reqPost.end();
      } catch (err) {
        // synchronous error writing the payload
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      }
    });
  });
}

/**
 * @param filename
 * @returns {Promise<TS.Tag[]>}
 */
export async function readMacOSTags(filename) {
  return new Promise((resolve, reject) => {
    const args = ['-raw', '-name', 'kMDItemUserTags', filename];
    execFile('mdls', args, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 1 && !stderr) {
          return resolve([]);
        }
        return reject(error);
      }
      if (stderr) return reject(new Error(stderr));

      const text = stdout.trim();
      if (!text || text === '(null)') {
        return resolve([]);
      }
      const tags = text
        .replace(/^\(|\)$/g, '')
        .split(',')
        .map((item) => ({ title: item.trim() }));
      resolve(tags);
    });
  });
}

/**
 * needs to run in init this function always return false first time
 */
export function isWorkerAvailable(): Promise<boolean> {
  /*if (settings.getToken() !== undefined) {
    return Promise.resolve(settings.getToken() !== 'not');
  }*/
  if (settings.getUsedWsPort()) {
    try {
      return fetch('http://127.0.0.1:' + settings.getUsedWsPort(), {
        method: 'HEAD',
      })
        .then((res) => {
          if (res.status === 200) {
            const config = require('./config/config.json');
            if (config && config.jwt) {
              settings.setToken(config.jwt);
              return true;
            } else {
              console.error('jwt token not generated');
              settings.setToken('not');
            }
          }
          return false;
        })
        .catch((e) => {
          console.debug('isWorkerAvailable:', e);
          return false;
        });
    } catch (e) {
      if (e && e.code && e.code === 'MODULE_NOT_FOUND') {
        console.error('WS error MODULE_NOT_FOUND');
        settings.setToken('not');
      }
      console.debug('isWorkerAvailable:', e);
    }
  }
  return Promise.resolve(false);
}

export function newProgress(key, total) {
  return {
    loaded: 0,
    total: total,
    key,
  };
}
export function getOnProgress(key, progress) {
  const controller = new AbortController();
  const signal = controller.signal;

  progress[key].abort = () => {
    controller.abort();
    //reject(new Error('Promise aborted'));
  };
  signal.addEventListener('abort', progress[key].abort);
  const onProgress = (newProgress, abortFunc, fileName) => {
    signal.removeEventListener('abort', progress[key].abort);
    progress[key].abort = () => {
      if (abortFunc) {
        abortFunc();
      }
      controller.abort();
      //reject(new Error('Promise aborted'));
    };
    signal.addEventListener('abort', progress[key].abort);
    try {
      const mainWindow = BrowserWindow.getFocusedWindow();
      mainWindow.webContents.send('progress', fileName, newProgress);
    } catch (ex) {
      console.error(ex);
    }
  };
  return onProgress;
}

export function stringifyMaxDepth(obj, depth = 1) {
  // recursion limited by depth arg
  if (!obj || typeof obj !== 'object') return JSON.stringify(obj);

  let curDepthResult = '"<?>"'; // too deep
  if (depth > 0) {
    curDepthResult = Object.keys(obj)
      .map((key) => {
        let val = stringifyMaxDepth(obj[key], depth - 1);
        if (val === undefined) val = 'null';
        return `"${key}": ${val}`;
      })
      .join(', ');
    curDepthResult = `{${curDepthResult}}`;
  }

  return JSON.stringify(JSON.parse(curDepthResult));
}
