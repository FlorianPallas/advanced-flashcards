import log from 'loglevel';
import { SyncService } from '../service';
import FlashcardsPlugin from 'src';
import AnkiBridge from './bridge';
import { Note } from './types';
import { Notice } from 'obsidian';
import { Article, Card } from '../../wiki';
import { encodeBase64 } from 'src/util';
import {
  AddNotesRequest,
  CreateDeckRequest,
  StoreMediaRequest,
  UpdateNoteRequest,
  NotesInfoRequest,
  DeleteNotesRequest,
  ChangeDeckRequest,
  GetMediaFileNamesRequest,
} from './requests';
import { processMarkdown } from './util';

interface CardRecord {
  card: Card;
  ankiNote: Note;
  ankiMedia: [src: string, filePath: string][];
  ankiCards?: number[];
}

export class AnkiConnectSyncService implements SyncService {
  private plugin: FlashcardsPlugin;
  private bridge: AnkiBridge;

  constructor(plugin: FlashcardsPlugin) {
    this.plugin = plugin;
    this.bridge = new AnkiBridge(plugin);
  }

  public async push(articles: Article[]) {
    new Notice('Pushing...');

    const [cardsToCreate, cardsToUpdate, cardsToDelete, cardsToIgnore] =
      await this.getCards(articles);
    log.debug('creating', cardsToCreate.length);
    log.debug('updating', cardsToUpdate.length);
    log.debug('deleting', cardsToDelete.length);
    log.debug('ignoring', cardsToIgnore.length);

    const decksToCreate: string[] = [];
    for (const { ankiNote } of cardsToCreate) {
      if (decksToCreate.contains(ankiNote.deckName)) continue;
      decksToCreate.push(ankiNote.deckName);
    }
    await this.bridge.sendMulti(
      decksToCreate.map((deckName) => new CreateDeckRequest(deckName))
    );

    const newNoteIds = await this.bridge.send(
      new AddNotesRequest(cardsToCreate.map(({ ankiNote }) => ankiNote))
    );
    for (let i = 0; i < newNoteIds.length; i++) {
      const noteId = newNoteIds[i];
      if (!noteId) {
        log.warn('failed to create card', cardsToCreate[i]);
        continue;
      }
      this.plugin.labelMap.set(cardsToCreate[i].card.label, noteId);
    }

    await this.bridge.sendMulti(
      cardsToUpdate.map(({ ankiNote }) => new UpdateNoteRequest(ankiNote))
    );
    await this.bridge.sendMulti(
      cardsToUpdate.map(
        ({ ankiNote }) =>
          new ChangeDeckRequest([ankiNote.id || -1], ankiNote.deckName)
      )
    );

    const existingFiles = await this.bridge.send(
      new GetMediaFileNamesRequest('*')
    );
    const ignoredFiles = cardsToIgnore.flatMap(({ ankiMedia }) => ankiMedia);
    const missingFiles = ignoredFiles.filter(
      ([src]) => !existingFiles.includes(src)
    );

    const toMediaRequest = async ([src, filePath]: [string, string]) => {
      const arrayBuffer = await this.plugin.app.vault.adapter.readBinary(
        filePath
      );
      const data = encodeBase64(arrayBuffer);
      return new StoreMediaRequest(src, data);
    };

    const mediaRequests = await Promise.all(
      cardsToUpdate
        .concat(cardsToCreate)
        .flatMap(({ ankiMedia }) => ankiMedia.map(toMediaRequest))
    );
    mediaRequests.push(
      ...(await Promise.all(missingFiles.map(toMediaRequest)))
    );

    await this.bridge.sendMulti(mediaRequests);

    await this.bridge.send(
      new DeleteNotesRequest(cardsToDelete.map(([, id]) => id))
    );
    for (const [label] of cardsToDelete) {
      this.plugin.labelMap.delete(label);
    }

    new Notice(
      [
        'Done!',
        `Scanned\t${articles.length} file(s)`,
        `Found\t\t${
          cardsToCreate.length +
          cardsToUpdate.length +
          cardsToDelete.length +
          cardsToIgnore.length
        } card(s)`,
        '\n',
        `Created\t${cardsToCreate.length} card(s)`,
        `Updated\t${cardsToUpdate.length} card(s)`,
        `Deleted\t${cardsToDelete.length} card(s)`,
        `Ignored\t${cardsToIgnore.length} card(s)`,
        `Uploaded\t${mediaRequests.length} file(s)`,
      ].join('\n')
    );
  }

  private async getCards(
    articles: Article[]
  ): Promise<[CardRecord[], CardRecord[], [string, number][], CardRecord[]]> {
    const existingCards: CardRecord[] = [];

    const cardsToCreate: CardRecord[] = [];
    const cardsToUpdate: CardRecord[] = [];
    const cardsToDelete: [string, number][] = [];
    const cardsToIgnore: CardRecord[] = [];

    for (const article of articles) {
      for (const card of article.cards) {
        const record = await this.getRecord(card);
        const { ankiNote } = record;

        if (!ankiNote.id) {
          cardsToCreate.push(record);
          continue;
        }
        existingCards.push(record);
      }
    }

    const cardInfos = await this.bridge.send(
      new NotesInfoRequest(
        existingCards.map(({ ankiNote }) => ankiNote.id || -1)
      )
    );

    for (let i = 0; i < existingCards.length; i++) {
      const record = existingCards[i];
      const info = cardInfos[i];
      if (!info) {
        cardsToCreate.push(record);
        continue;
      }

      if (
        info.fields.Front.value !== record.ankiNote.fields.Front ||
        info.fields.Back.value !== record.ankiNote.fields.Back
      ) {
        cardsToUpdate.push(record);
        continue;
      }

      cardsToIgnore.push(record);
    }

    const knownLabels = Array.from(this.plugin.labelMap.entries());
    for (const [label, noteId] of knownLabels) {
      if (
        existingCards.findIndex(({ ankiNote }) => ankiNote.id === noteId) === -1
      ) {
        cardsToDelete.push([label, noteId]);
      }
    }

    return [cardsToCreate, cardsToUpdate, cardsToDelete, cardsToIgnore];
  }

  private async getRecord(card: Card): Promise<CardRecord> {
    const id = this.plugin.labelMap.get(card.label);

    const rootDeck = this.plugin.settings.rootDeck;
    let deckName = rootDeck;
    if (this.plugin.settings.useFolderDecks) {
      const deckPath =
        rootDeck +
        (rootDeck.trim().length > 0 ? '/' : '') +
        card.article.file.parent.path;
      deckName = deckPath.replace(/\//g, '::');
    }
    if (deckName === '::') {
      deckName = 'Default';
    }

    const ankiMedia: [string, string][] = [];

    const ankiNote: Note = {
      id,
      deckName,
      modelName: 'Basic',
      fields: {
        Front: await processMarkdown(card.front, ankiMedia),
        Back: await processMarkdown(card.back, ankiMedia),
      },
      tags: [],
      options: {
        allowDuplicate: false,
        duplicateScope: 'deck',
        duplicateScopeOptions: {
          deckName: 'Default',
          checkChildren: false,
          checkAllModels: false,
        },
      },
    };

    return { card, ankiNote, ankiMedia };
  }
}
