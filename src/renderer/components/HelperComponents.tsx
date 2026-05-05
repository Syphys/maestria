/**
 * TagSpaces - universal file and folder organizer
 * Copyright (C) 2021-present TagSpaces GmbH
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

import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useTranslation } from 'react-i18next';

export function BetaLabel() {
  const { t } = useTranslation();
  return (
    <Tooltip title={t('featureInBetaStatus')}>
      <Typography sx={{ display: 'initial' }}>
        <sup style={{ marginLeft: 5, textTransform: 'uppercase' }}>
          {t('betaStatus')}
        </sup>
      </Typography>
    </Tooltip>
  );
}

// Pro upsell components are intentionally neutered in this fork:
// - ProLabel / ProSign render nothing (no "PRO" superscript badges)
// - ProTooltip renders its children with the regular tooltip text only
//   (no "this is a Pro feature" message)
// Pro-gated feature buttons in the rest of the UI keep their `disabled` state
// where applicable, but the upsell hints are gone.

export function ProLabel(): null {
  return null;
}

export function ProSign(): null {
  return null;
}

export function ProTooltip(props: {
  tooltip?: string;
  placement?:
    | 'top'
    | 'bottom'
    | 'left'
    | 'right'
    | 'top-start'
    | 'top-end'
    | 'bottom-start'
    | 'bottom-end'
    | 'left-start'
    | 'left-end'
    | 'right-start'
    | 'right-end';
  children: React.ReactElement;
}) {
  const { tooltip, placement, children } = props;
  if (!tooltip) {
    return <div style={{ display: 'flex' }}>{children}</div>;
  }
  return (
    <Tooltip arrow placement={placement || 'top'} title={tooltip}>
      <div style={{ display: 'flex' }}>{children}</div>
    </Tooltip>
  );
}
