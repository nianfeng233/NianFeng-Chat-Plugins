/*
 * bilibili · 渠道配置 / 详情样式
 */
export const BILIBILI_CSS = `
.bil-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(12,14,20,.52);backdrop-filter:blur(3px)}
.bil-dialog{width:min(560px,94vw);max-height:88vh;overflow:auto;border-radius:16px;padding:20px 22px;background:var(--bg-elevated,#fff);color:var(--text-primary,#1f2329);box-shadow:0 24px 64px rgba(0,0,0,.28)}
.bil-dialog h3{margin:0 0 6px;font-size:17px}
.bil-sub{font-size:12.5px;line-height:1.65;color:var(--text-secondary,#6b7280);margin-bottom:14px}
.bil-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.bil-field>span{font-size:12.5px;font-weight:600}
.bil-field input,.bil-field select,.bil-field textarea{border:1px solid var(--border-color,#d9dde3);border-radius:9px;padding:8px 10px;font-size:13px;background:var(--bg-input,#fff);color:inherit;outline:none}
.bil-field textarea{min-height:76px;resize:vertical;font-family:inherit;line-height:1.55}
.bil-field input:focus,.bil-field select:focus,.bil-field textarea:focus{border-color:#fb7299;box-shadow:0 0 0 3px rgba(251,114,153,.14)}
.bil-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.bil-help{font-size:11.5px;line-height:1.6;color:var(--text-tertiary,#8b919c)}
.bil-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
.bil-btn{appearance:none;border:1px solid var(--border-color,#d9dde3);background:transparent;color:inherit;border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer}
.bil-btn:hover{border-color:#fb7299;color:#fb7299}
.bil-btn.primary{background:linear-gradient(135deg,#fb7299,#fc9a72);border-color:transparent;color:#fff}
.bil-btn.danger{color:#d6455d;border-color:rgba(214,69,93,.4)}
.bil-btn:disabled{opacity:.5;cursor:not-allowed}
.bil-qr{display:flex;align-items:center;justify-content:center;min-height:236px;border:1px dashed var(--border-color,#d9dde3);border-radius:12px;background:var(--bg-card,#fafbfc);margin:8px 0 12px}
.bil-qr svg,.bil-qr img{width:220px;height:220px;border-radius:8px}
.bil-status{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-secondary,#6b7280);margin-bottom:6px}
.bil-status .dot{width:8px;height:8px;border-radius:50%;background:#c9a227;flex:none}
.bil-error{margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(214,69,93,.08);color:#d6455d;font-size:12px;line-height:1.6;word-break:break-all}
.bil-account{display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border-color,#e6e9ee);border-radius:12px;margin-bottom:14px}
.bil-account img{width:46px;height:46px;border-radius:50%;object-fit:cover;background:#f0f2f5}
.bil-account .name{font-size:14px;font-weight:600}
.bil-account .uid{font-size:12px;color:var(--text-tertiary,#8b919c);margin-top:2px}
.bil-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;background:rgba(251,114,153,.12);color:#d9527d}
.bil-section{border:1px solid var(--border-color,#e6e9ee);border-radius:12px;padding:14px;margin-bottom:12px}
.bil-section-title{font-size:13px;font-weight:700;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.bil-tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.bil-tab{border:1px solid var(--border-color,#d9dde3);background:transparent;color:inherit;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}
.bil-tab.active{background:rgba(251,114,153,.14);border-color:#fb7299;color:#d9527d;font-weight:600}
.bil-checks{display:flex;flex-wrap:wrap;gap:10px 16px}
.bil-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer}
.bil-check input{accent-color:#fb7299}
.bil-note{padding:9px 11px;border-radius:9px;background:rgba(251,114,153,.07);color:var(--text-secondary,#6b7280);font-size:11.5px;line-height:1.7;margin-top:8px}
.bil-kv{display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:5px 0;border-bottom:1px dashed var(--border-color,#eceff3)}
.bil-kv:last-child{border-bottom:none}
.bil-kv .v{color:var(--text-tertiary,#8b919c);text-align:right;word-break:break-all}
.bil-log{max-height:180px;overflow:auto;font-size:11.5px;line-height:1.7;color:var(--text-secondary,#6b7280)}
.bil-log-line{padding:4px 0;border-bottom:1px dashed var(--border-color,#eceff3)}
.bil-log-line .t{color:var(--text-tertiary,#9aa0aa);margin-right:6px}
@media (max-width:640px){.bil-grid{grid-template-columns:1fr}}
`
