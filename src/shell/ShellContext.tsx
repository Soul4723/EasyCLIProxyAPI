import { createContext, useContext } from 'react';

type ShellContextValue = {
  /** Opens the sidebar drawer (viewport < 720px). */
  openMenu: () => void;
  menuOpen: boolean;
};

export const ShellContext = createContext<ShellContextValue>({ openMenu: () => {}, menuOpen: false });
export const useShell = () => useContext(ShellContext);
