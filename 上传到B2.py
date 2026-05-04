"""
Backblaze B2 图片上传脚本（防崩版本系统）
- 上传 all_categ_images 文件夹中的图片
- 上传到 Backblaze B2 的 CARTORERIA bucket
- MD5 去重 + 版本号递增 + 防写坏 + 多线程
"""

import os
import sys
import io
import time
import json
import hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# ==================== 输出编码 ====================
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ==================== B2 配置 ====================
B2_KEY_ID      = "ec0c29ea2c24"
B2_APP_KEY     = "0035dea5b7adb53db556962e643eebdb7a98653752"
B2_BUCKET_NAME = "CARTORERIA"

# 源图片文件夹（绝对路径，用原始字符串避免转义）
SOURCE_DIR = r"C:\Users\ASUS\WorkBuddy\20260503152929\all_categ_images"

# B2 下载域名（和 ECOSHOP 同一个账号，域名相同）
B2_DOWNLOAD_DOMAIN = "f003.backblazeb2.com"

MAX_RETRIES = 3
THREADS = 4

VERSION_FILE = Path(__file__).parent / "versions.json"
B2_VERSIONS_URL = f"https://{B2_DOWNLOAD_DOMAIN}/file/{B2_BUCKET_NAME}/versions.json"
lock = Lock()

# ==================== 安全加载 JSON ====================
def load_versions():
    data = {}
    if VERSION_FILE.exists():
        try:
            with open(VERSION_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            print("⚠️ 本地 versions.json 损坏，将重置", flush=True)

    fixed = {}
    for k, v in data.items():
        if isinstance(v, dict):
            fixed[k] = {
                "ver": int(v.get("ver") or 1),
                "md5": v.get("md5") or ""
            }
        else:
            fixed[k] = {
                "ver": int(v or 1),
                "md5": ""
            }
    return fixed

def merge_b2_versions(local_map, b2_map):
    """用 B2 上的版本号（取较大值）覆盖本地"""
    merged = dict(b2_map)
    for k, v in local_map.items():
        if k not in merged:
            merged[k] = v
        else:
            b2_ver = int(merged[k].get("ver") or 1) if isinstance(merged[k], dict) else int(merged[k] or 1)
            local_ver = int(v.get("ver") or 1) if isinstance(v, dict) else int(v or 1)
            if local_ver > b2_ver:
                merged[k] = v
    return merged

# ==================== 从 B2 下载最新版本 ====================
def download_b2_versions():
    """启动时从 B2 下载 versions.json，与本地合并"""
    import urllib.request
    try:
        req = urllib.request.Request(B2_VERSIONS_URL)
        with urllib.request.urlopen(req, timeout=10) as resp:
            b2_data = json.loads(resp.read().decode("utf-8"))

        b2_fixed = {}
        for k, v in b2_data.items():
            if isinstance(v, dict):
                b2_fixed[k] = {
                    "ver": int(v.get("ver") or 1),
                    "md5": v.get("md5") or ""
                }
            else:
                b2_fixed[k] = {
                    "ver": int(v or 1),
                    "md5": ""
                }

        print(f"📥 从 B2 下载了 {len(b2_fixed)} 条版本记录", flush=True)
        return b2_fixed

    except Exception as e:
        print(f"⚠️ 从 B2 下载版本失败: {e}（使用本地版本）", flush=True)
        return {}

# ==================== MIME ====================
MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

# ==================== MD5 ====================
def md5_of_file(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()

# ==================== 安全保存（防写坏） ====================
def save_versions():
    with lock:
        tmp = VERSION_FILE.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(version_map, f, indent=2, ensure_ascii=False)
        tmp.replace(VERSION_FILE)

# ==================== 上传 ====================
def upload_file(bucket, file_path):
    filename = os.path.basename(file_path)
    ext = Path(file_path).suffix.lower()
    content_type = MIME_MAP.get(ext, "application/octet-stream")

    local_md5 = md5_of_file(file_path)

    with lock:
        entry = version_map.get(filename)

        if isinstance(entry, dict):
            old_ver = int(entry.get("ver") or 0)
            old_md5 = entry.get("md5") or ""
        else:
            old_ver = int(entry or 0)
            old_md5 = ""

        if old_md5 == local_md5 and old_md5 != "":
            return True, filename, "skip", old_ver

    for i in range(MAX_RETRIES):
        try:
            bucket.upload_local_file(
                local_file=file_path,
                file_name=filename,
                content_type=content_type,
                cache_control="public, max-age=31536000"
            )

            with lock:
                new_ver = old_ver + 1
                version_map[filename] = {
                    "ver": new_ver,
                    "md5": local_md5
                }

            return True, filename, "ok", new_ver

        except Exception as e:
            time.sleep(2 ** i)

    return False, filename, "fail", 0

# ==================== 主程序 ====================
def main():
    from b2sdk.v2 import InMemoryAccountInfo, B2Api

    print("🛡️ 防崩版本系统启动", flush=True)
    print(f"📁 源文件夹: {SOURCE_DIR}", flush=True)
    print(f"☁️  目标 Bucket: {B2_BUCKET_NAME}", flush=True)

    # ========= 检查源文件夹 =========
    source_path = Path(SOURCE_DIR)
    if not source_path.exists():
        print(f"❌ 源文件夹不存在: {SOURCE_DIR}", flush=True)
        input("\n按回车键退出...")
        return

    # ========= 加载版本（本地 + B2 合并） =========
    global version_map
    local_versions = load_versions()
    b2_versions = download_b2_versions()
    version_map = merge_b2_versions(local_versions, b2_versions)
    print(f"📋 合并后版本记录: {len(version_map)} 条", flush=True)
    save_versions()

    # ========= 连接 B2 =========
    info = InMemoryAccountInfo()
    b2 = B2Api(info)

    try:
        b2.authorize_account("production", B2_KEY_ID, B2_APP_KEY)
        bucket = b2.get_bucket_by_name(B2_BUCKET_NAME)
        print(f"✅ 已连接: {B2_BUCKET_NAME}", flush=True)
    except Exception as e:
        print(f"❌ 连接失败: {e}", flush=True)
        input("\n按回车键退出...")
        return

    # ========= 扫描图片 =========
    files = [
        str(p)
        for p in source_path.iterdir()
        if p.is_file() and p.suffix.lower() in MIME_MAP
    ]

    total = len(files)
    if total == 0:
        print("⚠️ 在源文件夹中没有找到图片文件", flush=True)
        input("\n按回车键退出...")
        return

    print(f"📁 待处理: {total} 个文件\n", flush=True)

    ok = fail = skip = 0

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        futures = {pool.submit(upload_file, bucket, f): f for f in files}

        for i, fu in enumerate(as_completed(futures), 1):
            try:
                success, name, status, ver = fu.result()

                if success:
                    if status == "skip":
                        skip += 1
                        print(f"[{i}/{total}] ⏭ {name} (未变更)", flush=True)
                    else:
                        ok += 1
                        print(f"[{i}/{total}] ✅ {name} v{ver}", flush=True)
                else:
                    fail += 1
                    print(f"[{i}/{total}] ❌ {name}", flush=True)

                if (ok + skip + fail) % 20 == 0:
                    save_versions()

            except Exception as e:
                fail += 1
                print(f"[{i}/{total}] ❌ {e}", flush=True)

    # ========= 最终保存 + 上传到 B2 =========
    save_versions()

    if ok > 0:
        try:
            bucket.upload_local_file(
                local_file=str(VERSION_FILE),
                file_name="versions.json",
                content_type="application/json",
            )
            print(f"\n📄 versions.json 已上传到 B2 ({len(version_map)} 条)", flush=True)
        except Exception as e:
            print(f"\n⚠️ versions.json 上传失败: {e}", flush=True)
    else:
        print("\n（无文件变更，跳过 versions.json 上传）", flush=True)

    print("\n====================", flush=True)
    print(f"成功:{ok}  跳过(未变更):{skip}  失败:{fail}  总计:{total}", flush=True)
    print("====================", flush=True)

if __name__ == "__main__":
    main()
    input("\n按回车键退出...")
