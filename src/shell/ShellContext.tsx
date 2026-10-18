import { createContext, useContext } from 'react';

type ShellContextValue = {
  /** Opens the sidebar drawer (viewport < 720px). */
  openMenu: () => void;
};

export const ShellContext = createContext<ShellContextValue>({ openMenu: () => {} });
export const useShell = () => useContext(ShellContext);
