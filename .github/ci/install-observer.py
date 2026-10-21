"""Install CI-only debug observation into the job's disposable checkout.

The source branch and release builds do not contain or enable these hooks.
Adapted from the established dev-observe harness; fail closed on layout drift.
"""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
main = Path('src-tauri/src/main.rs')
text = main.read_text()

def replace_once(old, new):
    global text
    if text.count(old) != 1:
        raise SystemExit(f'Expected exactly one main-layout observer anchor: {old!r}')
    text = text.replace(old, new, 1)

replace_once('mod core_connection;', '#[cfg(debug_assertions)]\nmod dev_observe;\n\nmod core_connection;')
replace_once('    let app = app\n        .setup(move |app| {', '''    #[cfg(debug_assertions)]
    let app = app.on_page_load(dev_observe::on_page_load);

    let app = app
        .setup(move |app| {
            #[cfg(debug_assertions)]
            dev_observe::start_control(app.handle());''')
replace_once('.invoke_handler(tauri::generate_handler![', '.invoke_handler({\n            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![')
replace_once('        ])\n        .build(context)', '''            ];
            #[cfg(debug_assertions)]
            let handler = dev_observe::wrap(handler);
            handler
        })
        .build(context)''')
# Check all anchors before changing any source file.
main.write_text(text)
shutil.copy2(root / 'dev_observe.rs', main.parent / 'dev_observe.rs')
scripts = Path('scripts')
scripts.mkdir(exist_ok=True)
shutil.copy2(root / 'dev-observe.mjs', scripts / 'dev-observe.mjs')
shutil.copytree(root / 'dev-observe', scripts / 'dev-observe', dirs_exist_ok=True)
print('Installed CI-only debug observer for main layout')
