type Text = (zh: string, en: string) => string

/** Shared by file and Drive transport so a failed asset never appears as a raw code. */
export function syncAssetMessage(code: string, text: Text): string | null {
  const messages: Record<string, [string, string]> = {
    PROJECT_SYNC_ASSET_NOT_READY: ['本机资料尚未恢复完成，请重试恢复资料。待收更新会保留，恢复过程不会再次应用。', 'Local assets are not ready. Retry asset recovery. Pending updates are preserved; recovery does not apply them again.'],
    PROJECT_SYNC_ASSET_BUSY: ['本机资料正在处理，请稍后重试恢复资料。', 'Local assets are being processed. Retry asset recovery shortly.'],
    PROJECT_SYNC_ASSET_WRITE_FAILED: ['本机资料写入未完成，请检查目录是否可写和剩余空间，再重试恢复资料。', 'Local assets could not be written. Check folder access and free space, then retry asset recovery.'],
    PROJECT_SYNC_ASSET_MISSING_BYTES: ['资料文件尚未收齐，请完成云端传输或重新导入完整变更包后再刷新。', 'Some asset bytes are missing. Complete the cloud transfer or import a complete bundle, then refresh.'],
    PROJECT_SYNC_ASSET_BLOB_MISSING: ['云端缺少这次更新所需的资料文件，请在来源设备重新传输后再试。', 'The cloud is missing an asset required by this update. Transfer again from the source device.'],
    PROJECT_SYNC_ASSET_SOURCE_CHANGED: ['资料在读取期间发生变化。请保存并结束外部编辑后重新传输；当前输入已保留。', 'An asset changed while being read. Save and finish external edits, then transfer again. Current input is preserved.'],
    PROJECT_SYNC_ASSET_SELECTION_CHANGED: ['资料选择已变化，请刷新预览并重新核对版本。', 'The asset selection changed. Refresh the preview and review the versions again.'],
    PROJECT_SYNC_ASSET_NAME_CONFLICT: ['所选资料包含重名文件，请核对冲突版本，避免两个内容写入同一位置。', 'The selected assets contain colliding filenames. Review the conflict versions before applying.'],
    PROJECT_SYNC_ASSET_OWNER_MISSING: ['资料关联的人物或知识条目不完整，请从来源设备重新导出完整变更。', 'An asset refers to a missing character or knowledge entry. Export complete changes from the source device.'],
    PROJECT_SYNC_ASSET_HASH_MISMATCH: ['资料未通过完整性校验，尚未采用。请核对来源文件后重新传输；现有损坏文件不会被自动覆盖。', 'An asset failed integrity verification and was not adopted. Check its source and transfer again; existing damaged files are not overwritten automatically.'],
    PROJECT_SYNC_ASSET_TOO_LARGE: ['单项资料超过当前支持的大小，请拆分后再传输；Google Drive 单项资产上限为 2 GiB。', 'An asset exceeds the supported size. Split it before transferring; Google Drive assets are limited to 2 GiB each.'],
    SYNC_PACKAGE_TOO_LARGE: ['手动变更包超过 64 MiB 总上限（含资料编码），请使用 Google Drive 按需分块传输，或减少资料后重新导出。', 'The manual bundle exceeds the total 64 MiB limit including asset encoding. Use Google Drive chunked transfer or reduce the assets before exporting again.'],
    SYNC_ASSET_PREVIEW_INVALID: ['资料预览请求已无效，请刷新预览并重新核对。', 'The asset preview request is invalid. Refresh the preview and review again.'],
  }
  if (messages[code]) return text(...messages[code])
  if (/^(?:PROJECT_SYNC_ASSET_INLINE_|SYNC_INLINE_ASSET_)/.test(code)) return text('变更包中的资料不完整或编码无效，尚未采用。请在来源设备重新导出完整包。', 'The bundle has incomplete or invalid asset data and was not adopted. Export a complete bundle from the source device.')
  if (code.startsWith('PROJECT_SYNC_ASSET_')) return text('项目资料校验未通过，尚未采用。请核对来源内容并刷新或重新传输。', 'Project assets failed validation and were not adopted. Check the source, then refresh or transfer again.')
  return null
}

export function needsLocalAssetRecovery(code: string): boolean {
  return ['PROJECT_SYNC_ASSET_NOT_READY', 'PROJECT_SYNC_ASSET_BUSY', 'PROJECT_SYNC_ASSET_WRITE_FAILED'].includes(code)
}
