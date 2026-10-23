#!/usr/bin/env node
/**
 * 打一个 MedCollect 的 Android APK。
 *
 *   node scripts/build-apk.mjs            # debug 包，直接装到手机
 *   node scripts/build-apk.mjs --release  # release 包（未签名，需要自己配签名）
 *
 * 为什么要这个脚本：AGP 8.10 只认 JDK 17~21，而 Windows 上 `java` 常常是更新的版本；
 * 这里先挑一个能用的 JDK，再找 Gradle，最后打印 APK 路径。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(root, 'android');
const isWindows = process.platform === 'win32';
const release = process.argv.includes('--release');
const task = release ? 'assembleRelease' : 'assembleDebug';

function javaVersionOf(home) {
  try {
    const text = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const match = text.match(/JAVA_VERSION="(\d+)/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function findJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft']) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (/jdk|jre/i.test(name)) candidates.push(path.join(base, name));
      }
    } catch {
      // 目录不存在就算了
    }
  }
  const usable = candidates
    .filter((home) => javaVersionOf(home) >= 17 && javaVersionOf(home) <= 21)
    .sort((a, b) => javaVersionOf(b) - javaVersionOf(a));
  return usable[0] || '';
}

function findGradle() {
  // 已经装了 Gradle 就直接用，省得 wrapper 再下一次 130MB
  if (process.env.GRADLE_HOME) {
    const installed = path.join(process.env.GRADLE_HOME, 'bin', isWindows ? 'gradle.bat' : 'gradle');
    if (fs.existsSync(installed)) return installed;
  }
  const wrapper = path.join(android, isWindows ? 'gradlew.bat' : 'gradlew');
  if (fs.existsSync(wrapper)) return wrapper;
  const probe = spawnSync('gradle', ['--version'], { stdio: 'ignore', windowsHide: true });
  return probe.status === 0 ? 'gradle' : '';
}

const jdk = findJdk();
if (!jdk) {
  console.error('找不到 JDK 17~21（AGP 8.10 不支持更新的版本）。装一个 JDK 21，或设置 JAVA_HOME 指向它。');
  process.exit(2);
}

const gradle = findGradle();
if (!gradle) {
  console.error('找不到 Gradle。用 Android Studio 打开 android/ 目录，或安装 Gradle 8.11+。');
  process.exit(2);
}

if (!fs.existsSync(path.join(android, 'local.properties'))) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (sdk) {
    fs.writeFileSync(path.join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);
  } else {
    console.error('没有 local.properties，也找不到 ANDROID_HOME / ANDROID_SDK_ROOT。先装 Android SDK。');
    process.exit(2);
  }
}

console.log(`JDK:    ${jdk}`);
console.log(`Gradle: ${gradle}`);
console.log(`任务:   ${task}\n`);

const args = ['-p', android, task, '--console=plain'];
// Windows 上 gradle 是 .bat：Node 不允许直接 spawn .bat，必须交给 shell
const result = isWindows
  ? spawnSync(`"${gradle}" ${args.map((a) => `"${a}"`).join(' ')}`, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, JAVA_HOME: jdk },
      windowsHide: false,
    })
  : spawnSync(gradle, args, {
      stdio: 'inherit',
      env: { ...process.env, JAVA_HOME: jdk },
      windowsHide: false,
    });

if (result.error) {
  console.error(`构建没跑起来：${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const apk = path.join(android, 'app', 'build', 'outputs', 'apk',
  release ? 'release' : 'debug', release ? 'app-release-unsigned.apk' : 'app-debug.apk');
if (fs.existsSync(apk)) {
  const bytes = fs.statSync(apk).size;
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
  console.log(`\nAPK: ${apk}  (${size})`);
  console.log('装到手机： adb install -r "' + apk + '"');
} else {
  console.log('\n构建结束，但没有找到预期的 APK，请检查上面的输出。');
}
