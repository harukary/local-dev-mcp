import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export type SnapshotCopyMode = "reflink" | "copy";

export type SnapshotCopyResult = {
  copyMode: SnapshotCopyMode;
  fileCount: number;
  copiedBytes: number;
  excludedBytes: number;
};

type CopyFileImpl = (source: string, destination: string) => Promise<SnapshotCopyMode>;

type SnapshotCopyOptions = {
  profileDirectory?: string;
  copyFileImpl?: CopyFileImpl;
  rawCopyFile?: typeof copyFile;
};

const ROOT_FILES = new Set(["Local State"]);
const PROFILE_DIRECTORY_EXCLUDES = new Set([
  "Cache",
  "Code Cache",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
  "blob_storage",
  "download_cache",
]);
const VOLATILE_FILES = new Set([
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);
const FALLBACK_COPY_CODES = new Set(["ENOTSUP", "ENOSYS", "EXDEV", "EINVAL"]);

export async function copyChromeProfileSnapshot(
  sourceRoot: string,
  destinationRoot: string,
  options: SnapshotCopyOptions = {},
): Promise<SnapshotCopyResult> {
  const profileDirectory = options.profileDirectory ?? "Default";
  const rawCopyFile = options.rawCopyFile ?? copyFile;
  const copyFileImpl = options.copyFileImpl ?? createReflinkCopy(rawCopyFile);
  const result: SnapshotCopyResult = { copyMode: "reflink", fileCount: 0, copiedBytes: 0, excludedBytes: 0 };
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });

  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && ROOT_FILES.has(entry.name)) {
      await copyTree(sourceRoot, destinationRoot, source, profileDirectory, copyFileImpl, result);
      continue;
    }
    if (entry.isDirectory() && entry.name === profileDirectory) {
      await copyTree(sourceRoot, destinationRoot, source, profileDirectory, copyFileImpl, result);
      continue;
    }
    result.excludedBytes += await estimateBytes(source);
  }

  return result;
}

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  source: string,
  profileDirectory: string,
  copyFileImpl: CopyFileImpl,
  result: SnapshotCopyResult,
): Promise<void> {
  const info = await lstat(source);
  const relativePath = relative(sourceRoot, source);
  const destination = join(destinationRoot, relativePath);
  const name = basename(source);
  if (info.isSymbolicLink() || VOLATILE_FILES.has(name)) return;
  if (info.isDirectory()) {
    if (relativePath.startsWith(`${profileDirectory}/`) && PROFILE_DIRECTORY_EXCLUDES.has(name)) {
      result.excludedBytes += await estimateBytes(source);
      return;
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      await copyTree(sourceRoot, destinationRoot, join(source, entry), profileDirectory, copyFileImpl, result);
    }
    return;
  }
  if (!info.isFile()) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const mode = await copyFileImpl(source, destination);
  if (mode === "copy") result.copyMode = "copy";
  result.fileCount += 1;
  result.copiedBytes += info.size;
}

function createReflinkCopy(rawCopyFile: typeof copyFile): CopyFileImpl {
  return async (source, destination) => {
    try {
      await rawCopyFile(source, destination, constants.COPYFILE_FICLONE_FORCE);
      return "reflink";
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (!FALLBACK_COPY_CODES.has(code)) throw error;
      await rawCopyFile(source, destination, undefined);
      return "copy";
    }
  };
}

async function estimateBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path)) total += await estimateBytes(join(path, entry));
  return total;
}
