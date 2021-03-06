import { Notice, Setting } from 'obsidian';
import FlashcardsPlugin from 'src';
import { SettingsLoader } from 'src/config/loaders/SettingsLoader';
import { Fold } from '../components';

export class CollaborationCategory {
  private labelsFold?: Fold;
  private tempLabelMapPath?: string;

  public constructor(containerEl: HTMLElement, plugin: FlashcardsPlugin) {
    this.create(containerEl, plugin);
  }

  private create(containerEl: HTMLElement, plugin: FlashcardsPlugin) {
    new Setting(containerEl).setName('Collaboration').setHeading();

    new Setting(containerEl)
      .setName('Use Labels')
      .setDesc(
        'Instead of identifying cards by client specific ids, use labels to let each user have their own set of cards.'
      )
      .addToggle((toggle) => {
        toggle
          .setValue(plugin.settings.useLabels)
          .setDisabled(true)
          .onChange((value) => {
            plugin.settings.useLabels = value;
            plugin.save();
            this.labelsFold?.setExpanded(value);
          });

        toggle.toggleEl.style.opacity = '0.5';
        toggle.toggleEl.style.pointerEvents = 'none';
      });

    this.labelsFold = new Fold(containerEl).setExpanded(
      plugin.settings.useLabels
    );

    new Setting(this.labelsFold.foldEl)
      .setName('Label map path')
      .setDesc('')
      .addText((text) => {
        text
          .setValue(plugin.settings.labelMapPath)
          .setPlaceholder(SettingsLoader.defaults.labelMapPath)
          .onChange((value) => {
            this.tempLabelMapPath = value;
          });
      })
      .addButton((button) => {
        button.setButtonText('Load').onClick(async () => {
          plugin.settings.labelMapPath =
            this.tempLabelMapPath ?? plugin.settings.labelMapPath;
          plugin.labelMap = await plugin.labelMapLoader.load(
            plugin.settings.labelMapPath
          );
          await plugin.save();
          new Notice('Loaded!');
        });
      });
  }
}
