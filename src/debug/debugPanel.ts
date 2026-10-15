import GUI from 'lil-gui';
import { tuning, tuningMeta, resetTuning } from '../config/tuning';

/**
 * lil-gui panel bound directly to the live tuning object. Toggle with the
 * backtick key. Edits apply on the next simulation tick.
 */
export class DebugPanel {
  private gui: GUI | null = null;
  visible = false;
  extra: Record<string, unknown> = {};

  constructor(private readonly onExtras?: (gui: GUI) => void) {}

  private build(): void {
    const gui = new GUI({ title: 'SKYTHREAD tuning (`)', width: 320 });
    gui.domElement.style.zIndex = '50';
    // Groups become folders; nested groups (`enemies.<kind>`) become sub-folders.
    type Node = { [key: string]: number | Node };
    const addGroup = (parent: GUI, name: string, path: string, node: Node): void => {
      let folder: GUI | null = null;
      const ensure = (): GUI => {
        if (!folder) {
          folder = parent.addFolder(name);
          folder.close();
        }
        return folder;
      };
      for (const key of Object.keys(node)) {
        const v = node[key]!;
        if (typeof v !== 'number') {
          if (Object.keys(v).some((k) => tuningMeta[`${path}.${key}.${k}`])) addGroup(ensure(), key, `${path}.${key}`, v);
          continue;
        }
        const meta = tuningMeta[`${path}.${key}`];
        if (!meta) continue;
        ensure().add(node, key, meta[0], meta[1], meta[2]);
      }
    };
    const groups = tuning as unknown as Node;
    for (const group of Object.keys(groups)) addGroup(gui, group, group, groups[group] as Node);
    gui.add({ reset: () => { resetTuning(); gui.controllersRecursive().forEach((c) => c.updateDisplay()); } }, 'reset').name('Reset to defaults');
    this.onExtras?.(gui);
    this.gui = gui;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible && !this.gui) this.build();
    if (this.gui) this.gui.domElement.style.display = this.visible ? '' : 'none';
  }

  refresh(): void {
    this.gui?.controllersRecursive().forEach((c) => c.updateDisplay());
  }
}
