import { lazy, type ComponentType } from 'react';
import type { SectionPageProps } from './types';

type LazyModule = { default: ComponentType<SectionPageProps> };

export function lazySection(loader: () => Promise<LazyModule>) {
  let modulePromise: Promise<LazyModule> | null = null;
  const load = () => (modulePromise ??= loader());
  const createPage = () => lazy(load);
  let LazyPage = createPage();

  function Page(props: SectionPageProps) {
    return <LazyPage {...props} />;
  }

  return {
    Page,
    preload() {
      void load().catch(() => { modulePromise = null; });
    },
    retry() {
      modulePromise = null;
      LazyPage = createPage();
    },
  };
}
