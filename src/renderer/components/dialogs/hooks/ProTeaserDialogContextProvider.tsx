/**
 * Pro teaser dialog — neutralized in this fork.
 *
 * The original opens an upsell dialog with marketing slides. This fork strips
 * all Pro promotion, so `openProTeaserDialog` is a no-op and the dialog is
 * never rendered. The context shape is preserved so existing consumers
 * (FolderContainer, HelpFeedbackPanel, AiGenerationDialog, etc.) keep working
 * without code changes — they just trigger nothing.
 */

import React, { createContext, useMemo } from 'react';

type ProTeaserDialogContextData = {
  openProTeaserDialog: (slidePage?: string) => void;
  closeProTeaserDialog: () => void;
};

const NO_OP = (): void => {};

export const ProTeaserDialogContext = createContext<ProTeaserDialogContextData>(
  {
    openProTeaserDialog: NO_OP,
    closeProTeaserDialog: NO_OP,
  },
);

export type ProTeaserDialogContextProviderProps = {
  children: React.ReactNode;
};

export const ProTeaserDialogContextProvider = ({
  children,
}: ProTeaserDialogContextProviderProps) => {
  const context = useMemo(
    () => ({
      openProTeaserDialog: NO_OP,
      closeProTeaserDialog: NO_OP,
    }),
    [],
  );

  return (
    <ProTeaserDialogContext.Provider value={context}>
      {children}
    </ProTeaserDialogContext.Provider>
  );
};
