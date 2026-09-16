import type { SurfaceDiff } from '../diff.js';
import { safeKey } from '../change-groups.js';
import type { ContentSurface } from './content-layer.js';

/** Migration gallery section labels (#566 Q9) — locked, never change. */
export const MIGRATION_GALLERY_LABELS = {
  changedStyles: 'Changed styles',
  newSurfaces: 'New surfaces',
  newRemovedElements: 'New/removed elements',
} as const;

/** Migration-mode gallery sections. Removed surfaces (Q10) stay separate. */
export type MigrationGallery = {
  changedStyles: { surface: string; findingCount: number }[];
  newSurfaces: { surface: string }[];
  newRemovedElements: { surface: string; added: number; removed: number; retagged: number }[];
};

export function buildMigrationGallery(surfaces: SurfaceDiff[], contentSurfaces: ContentSurface[]): MigrationGallery {
  const gallery: MigrationGallery = { changedStyles: [], newSurfaces: [], newRemovedElements: [] };
  for (const sd of surfaces) {
    if (sd.classification === 'changed')
      gallery.changedStyles.push({ surface: sd.surface, findingCount: sd.findings.length });
    else if (sd.classification === 'genuinely-new') gallery.newSurfaces.push({ surface: sd.surface });
  }
  for (const { surface, changes } of contentSurfaces) {
    const structure = changes.filter((c) => c.kind === 'structure');
    if (!structure.length) continue;
    const count = (change: string) => structure.filter((c) => c.change === change).length;
    gallery.newRemovedElements.push({
      surface,
      added: count('added'),
      removed: count('removed'),
      retagged: count('retagged'),
    });
  }
  return gallery;
}

function section(heading: string, intro: string, items: string[]): string[] {
  return items.length ? ['', heading, '', intro, '', ...items] : [];
}

export function renderMigrationGallerySections(g: MigrationGallery): string[] {
  const md: string[] = [];
  if (g.changedStyles.length || g.newSurfaces.length || g.newRemovedElements.length) {
    md.push(
      '',
      '---',
      '',
      '## 🗺️ StyleProof Migration Report',
      '',
      '_Migration mode compares two heads where changes are expected. Review the sections below: ' +
        'Changed styles, New surfaces, and New/removed elements._',
    );
  }
  md.push(
    ...section(
      `### 🎨 ${MIGRATION_GALLERY_LABELS.changedStyles}`,
      `_${g.changedStyles.length} surface(s) with computed-style differences._`,
      g.changedStyles.map(({ surface, findingCount }) => `- \`${safeKey(surface)}\` · ${findingCount} finding(s)`),
    ),
    ...section(
      `### 🆕 ${MIGRATION_GALLERY_LABELS.newSurfaces}`,
      `_${g.newSurfaces.length} surface(s) present only in head capture (genuinely new)._`,
      g.newSurfaces.map(({ surface }) => `- \`${safeKey(surface)}\``),
    ),
    ...section(
      `### 🧱 ${MIGRATION_GALLERY_LABELS.newRemovedElements}`,
      '_Element-level structure changes within surfaces. Elevated from advisory — reviewable in migration mode._',
      g.newRemovedElements.map(({ surface, added, removed, retagged }) => {
        const parts = [
          [added, 'added'],
          [removed, 'removed'],
          [retagged, 'retagged'],
        ].filter(([n]) => (n as number) > 0);
        return `- \`${safeKey(surface)}\` · ${parts.map(([n, label]) => `${n} ${label}`).join(', ')}`;
      }),
    ),
  );
  return md;
}
