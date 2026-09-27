import type { FileChangeReport } from '../../src/file-changes';
import { HtmlArtifact } from './MessageContent';

export function FileChanges({ report }: { report: FileChangeReport }) {
  return (
    <section className="file-changes" aria-label="実行中に確認したファイル変更">
      <strong>ファイル変更 · {report.files.length}件</strong>
      <small>編集通知で確認できたファイル · パスは作業フォルダからの相対表記</small>
      {report.concurrent && <p role="status">同じ作業フォルダで他の実行も進行していました。</p>}
      {report.partial && (
        <p role="status">
          一部の対象ファイルは読み取り不可または表示上限のため確認できませんでした。
        </p>
      )}
      {report.files.map((file) => (
        <article className="file-change" key={file.path}>
          <header>
            <span>
              {file.operation === 'added' ? '追加' : file.operation === 'deleted' ? '削除' : '変更'}
            </span>
            <strong>{file.path}</strong>
            {file.added !== undefined && (
              <span className="file-change-count">
                +{file.added} −{file.deleted}
                {file.approximate ? '（概算）' : ''}
              </span>
            )}
          </header>
          {file.workspaceId && file.operation !== 'deleted' && (
            <a
              href={`/workspace?${new URLSearchParams({ path: file.path, workspaceId: file.workspaceId })}`}
            >
              ファイルを開く
            </a>
          )}
          {file.diff && (
            <details>
              <summary>差分を見る</summary>
              <pre aria-label={`${file.path}の差分`}>
                <code>
                  {file.diff.split('\n').map((line, index) => (
                    <span
                      key={index}
                      className={
                        line.startsWith('+')
                          ? 'diff-added'
                          : line.startsWith('-')
                            ? 'diff-deleted'
                            : ''
                      }
                    >
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </code>
              </pre>
            </details>
          )}
          {file.truncated && (
            <small>
              {file.omittedReason ??
                (file.binary
                  ? 'バイナリファイルの内容は表示しません。'
                  : 'この履歴には差分を表示できない理由が記録されていません。')}
            </small>
          )}
          {file.workspaceId && file.operation !== 'deleted' && /\.html?$/i.test(file.path) && (
            <details>
              <summary>HTMLプレビュー</summary>
              <HtmlArtifact path={file.path} workspaceId={file.workspaceId} />
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
