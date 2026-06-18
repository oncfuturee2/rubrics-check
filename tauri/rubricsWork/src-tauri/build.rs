use std::{env, fs, path::Path};

fn main() {
    generate_embedded_workbench_assets();
    tauri_build::build();
}

fn generate_embedded_workbench_assets() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is missing");
    let root = Path::new(&manifest_dir).join("resources").join("workbench-dist");
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR is missing");
    let output = Path::new(&out_dir).join("embedded_workbench.rs");

    println!("cargo:rerun-if-changed={}", root.display());
    println!("cargo:rerun-if-changed={}", Path::new(&manifest_dir).join("icons").join("icon.ico").display());
    println!("cargo:rerun-if-changed={}", Path::new(&manifest_dir).join("icons").join("icon.png").display());

    let mut files = Vec::new();
    collect_files(&root, &root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut generated = String::from("pub static WORKBENCH_ASSETS: &[(&str, &[u8])] = &[\n");
    for (asset_path, source_path) in files {
        generated.push_str(&format!(
            "    ({:?}, include_bytes!(r#\"{}\"#)),\n",
            asset_path,
            source_path.display()
        ));
    }
    generated.push_str("];\n");

    fs::write(output, generated).expect("failed to write embedded workbench assets");
}

fn collect_files(root: &Path, current: &Path, files: &mut Vec<(String, std::path::PathBuf)>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files);
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let asset_path = relative.to_string_lossy().replace('\\', "/");
        files.push((asset_path, path));
    }
}
