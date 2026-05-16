/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2017-present TagSpaces GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License (version 3) as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

import { app, Menu, nativeImage, Tray } from 'electron';

let tray;

const icon1x =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABzUlEQVR4AZSRz0tUURTHv+dOapHz5o7vTbWIEFsE/QWFES2DAqFFm6a/IAoNpEUZuqiIoMHathhs16q/QFyp4ErwD1BHRNDx1zj+QN49ft8bZ5Cn8vRwz/vec885n3suz+ASZmFtsvxCAM8W3nr2xoLLt21wv+p1BZ+boFSAl/ffAPoL4u5AFQIN4DDSmfO/RJAWwLP+a+t1lbL2Zl+UaLnKANgmaJjGIsiIGcR9tMcAmw3ei8iYy5h+Qfi/M1d4idi6r1LuQjS6HOREi84Y2uZX/B4Dml7Bc07HHZgU0t1TxDa/T1lE41q0lIfR6qh1LDYAilmAQypfyCoHmcOxsYDvZ8A0v8ySwz3PS8tY3jXXuwu32PuCx3WOekitMR7I5oNKzgaVENLPri2+wkUAsEid1pygD7dxzdTnV1f4wDE2lqjfAYyqallFyyGoxpWLj4NxhX5lzW9V900yGCXgL5awx0mA7c3q0EnfYbyzXh1qarE33z7x6d4f1ryrbVU/bke59bVhXoYYEG3O85mfj3og5lk9NMWzalIBB6G+4uj8MyH1NCIVIE4zqhhRlX9TPx48SSJSAb0fJoeb/nBweuLSgGRDMk6dINmQjI8AAAD//y+rH9kAAAAGSURBVAMAtou2IZ3tlykAAAAASUVORK5CYII=';
const icon1xMac =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABi0lEQVR4AaSQvUpdQRSFv9kxl4Tb3CJFCgnBvEjKQAJCijTGJxBFBSu5ooWKlaitxUU7K59AfAXBB/CvECxU5Kqg7O2acxQ9Kl7FObNm1l5n7XVmjvGG0aDReGx/XYDZoBp3Tzg9hnSEMcHt6BxgNoD7YoJvEKQUX/A0ZcZ0zngY0C9hXugV7mf4iJpVJ/ITIaogD8bEamWAMapiJcEwsA78E/gOn+T9kXtCJJ+AuxHpo2hPEZCcPyg/G7Wh4/1CYwcuFbon+mBKyVUq3HtFQGBbWSsg3Z3tgmsJI98/56rKM0oe5OueW71e/wr+V6/ayr7SfiaMCPty7uMMR+JUbS5NEvk3ZE8v3d2frd1uH+oYK1jMBzYn0wJGS1qLsJbqjA2zmNFplgJmpS0YrHJwcKEdfYSmlqaYUHJHO17WQa3mLMszpOZxoan3k9r1rby+jJ5E+n2J/X/OZs+JFc3oC0J3976Kflt0DnD7IO9UwBpdXT/FK7NzAD6pjhLX15vilfmKgIr/SfHugBsAAAD///BHlHoAAAAGSURBVAMAfLR0IVLmjioAAAAASUVORK5CYII=';
const icon2xBlack =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB40lEQVR4AeyUv0sjQRTHvxMFOS6cXHflFdeeYKugWGghVirYWFooFlaWAcV/QOwsrOxtBRsVLQRtFEHtBK0EC8FGiBk/bydZkl0DG40KssP77vsx7837zttNCvrilRPIJ5BP4FtP4Cd/MQPgP2gqHzIBDl2Q0z3Yp/MZ2AF/QErITcXeGxipSKvy6gKqrmHJbeiV1YzAILnT4AdoVaZSBU4Mw49K+qvEShEgME/OHtgER6BV+RUK6ErbyPaqDaMY+XUP+tV5mIxvAiXn7AD1dEo2DQtlxYFktXR1QPG6xToHDZIiwO4JkPdW7J7K0oX5LWCN+25bvvMuouLM6dCiqSSSBGZVUDdVxyReUmhf74pUWMdfJznSZjci7BOzfMu5wT7w8ldwOOUqW3rWUPWccfZi4czYNmNLFZXkNYYzyAEz6FJRlZJpXk+kVSRH9Qj75Fhj8qO9SV74AGeNEJ8DJRUrtneIHUshtoJxh0rhUWqMPSb8sA8/9Vp9Lb+mLRaBumoMN0iSQIi+7dlPWa+69RudWdpNQHqQEfkSAn0utO0LKtuzLRP4J3XRrp+vXZD4/Alcd8puvQyJZUjsojtAJmnLBMplWdMlOtbwjJ1J2kIgU6cmSTmBfAL5BD58Ak1+fXH4BQAA//8GCuDeAAAABklEQVQDAKrQdUFKrluKAAAAAElFTkSuQmCC';
const icon2xWhite =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABzklEQVR4AexUv0vDQBT+LooiiuLm6OCq0LWFFgcdxEkFF0cHxcHJsaD4D4hbByd3V6FLFR0EXRRBxbFOguBaJD6/uzQhTcSe9YpQcrwv70feu/flJRcP/7wyAtkEsgn07gREZJgoijSmf/rVdGUCbLzNpm/EOTBwR79KTNBPiXMCbDQPyAExGOs2R/uISMm3BLhJiVgjhlIV7QOrgAIMEF8L3G8yHtB2ioDvy5YAZwCO+RRX1L+V0WQB9wtDI6ER6hQBz8Oy5g9TpWZEPkphsqW+SOaZ/YAXpdR98l6KABNugt7m2gD6HxizFjY5ZPIpkZSdZED7nr6E4DvaoD1GxteAegRQJfYZr8ThizR9vxLYfkV8E6tqnzV1Qk/iifqWOCFmRZgnskQ7khYCjOrEMvUioUe/Tq39FrCo6XvlwPbK8KBj9cA39gpriwRPBTapeZ95wCXtSJgf2eD4XjsFd/kkcjb1zIukhUAU7cDwgQLLcu8i49TW4oxAX0AAY01ty8AZATbMwxwc5GlbixMC8iz6t1uAMgwK1t2Z6IQApsxT7wGKQI1Hlm8EVssJAaVUjdiNgd+kVX+eXru8rmU5mcBf2GUEsgn0/gTanZAvAAAA///3D9guAAAABklEQVQDAHmttEHwh1DxAAAAAElFTkSuQmCC';

export default function buildTrayMenu(
  mainPageProps: any,
  i18n,
  isMacLike,
  globalShortcutsEnabled,
) {
  // const cKey = isMacLike ? '  -  ⌘' : '  -  Ctrl';
  // const sKey = isMacLike ? '⇧' : 'Shift';
  // const pKey = isMacLike ? ' ' : ' + ';

  function openNextFile() {
    mainPageProps.openNextFile();
  }

  function openPrevFile() {
    mainPageProps.openPrevFile();
  }

  function playResumePlayback() {
    mainPageProps.resumePlayback();
  }

  function quitApp() {
    app.quit();
  }

  const trayMenuTemplate = [
    {
      label: i18n.t('newWindow'),
      click: () => mainPageProps.createNewWindowInstance(),
    },
    {
      type: 'separator',
    },
    {
      label: i18n.t('showTagSpaces'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+w' : undefined,
      click: mainPageProps.showTagSpaces,
    },
    {
      label: i18n.t('showSearch'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+f' : undefined,
      click: mainPageProps.openSearch,
    },
    {
      type: 'separator',
    },
    {
      label: i18n.t('newFileNote'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+n' : undefined,
      click: mainPageProps.toggleNewFileDialog,
    },
    {
      type: 'separator',
    },
    {
      label: i18n.t('openNextFileTooltip'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+d' : undefined,
      click: openNextFile,
    },
    {
      label: i18n.t('openPrevFileTooltip'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+a' : undefined,
      click: openPrevFile,
    },
    {
      type: 'separator',
    },
    {
      label: i18n.t('pauseResumePlayback'),
      accelerator: globalShortcutsEnabled ? 'CmdOrCtrl+Shift+p' : undefined,
      click: playResumePlayback,
    },
    {
      type: 'separator',
    },
    {
      label: i18n.t('quitTagSpaces'),
      accelerator: 'CmdOrCtrl+q',
      click: quitApp,
    },
  ];

  if (!tray) {
    let icon;
    if (isMacLike) {
      icon = nativeImage.createFromDataURL(icon1xMac);
      icon.addRepresentation({
        scaleFactor: 2.0,
        dataURL: icon2xBlack,
      });
      icon.setTemplateImage(true);
    } else {
      icon = nativeImage.createFromDataURL(icon1x);
    }
    tray = new Tray(icon);
  }

  // @ts-ignore
  const contextMenu = Menu.buildFromTemplate(trayMenuTemplate);
  tray?.setToolTip('Maestria');
  tray?.setContextMenu(contextMenu);
}
