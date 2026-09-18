import { App, Modal, Setting } from "obsidian";

/** Asks a yes/no question in an Obsidian modal; resolves true only if the user confirms. */
export function confirmAction(app: App, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, message, confirmLabel, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private confirmed = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly confirmLabel: string,
    private readonly onDone: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => {
            this.confirmed = true;
            this.close();
          })
      );
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDone(this.confirmed);
  }
}
