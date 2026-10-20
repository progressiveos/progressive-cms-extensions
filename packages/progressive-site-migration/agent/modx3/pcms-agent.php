<?php
/**
 * pcms-agent.php — Progressive CMS migration agent for MODX 3.0/3.2.
 *
 * Drop this file into the MODX web root, set the token below, and let the
 * PCMS side pull the export over HTTPS. The agent bootstraps the real modX
 * API (no DB credentials leave the site), answers read-only requests, and
 * speaks PCMS's format: resources with TVs (MIGX values passed through
 * verbatim), media sources/files, content types, detected extras
 * (Gallery, SEO Suite) and their redirect history.
 *
 * Install:
 *   1. Copy to the MODX web root (next to index.php).
 *   2. Set PCMS_AGENT_TOKEN to a long random string.
 *   3. (Optional) list allowed source IPs in PCMS_AGENT_ALLOWED_IPS.
 *   4. HTTPS only. Delete the file when the migration is done.
 *
 * Usage (PCMS side calls these):
 *   GET pcms-agent.php?action=info
 *   GET pcms-agent.php?action=tvs
 *   GET pcms-agent.php?action=resources&offset=0&limit=500
 *   GET pcms-agent.php?action=media-sources
 *   GET pcms-agent.php?action=media-files&source=<id>&offset=0&limit=2000
 *   GET pcms-agent.php?action=redirects
 * Auth: header "X-PCMS-Agent-Token: <token>".
 */

declare(strict_types=1);

const PCMS_AGENT_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const PCMS_AGENT_ALLOWED_IPS = [];
const PCMS_AGENT_MAX_LIMIT = 500;
const PCMS_AGENT_MAX_FILE_LIST = 5000;

ini_set('display_errors', '0');
error_reporting(E_ALL);

function pcms_fail(string $message, int $status = 400): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function pcms_respond(array $payload): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    pcms_fail('GET only', 405);
}
$token = $_SERVER['HTTP_X_PCMS_AGENT_TOKEN'] ?? '';
if (PCMS_AGENT_TOKEN === '' || PCMS_AGENT_TOKEN === 'CHANGE_ME_TO_A_LONG_RANDOM_STRING') {
    pcms_fail('agent is not configured: set PCMS_AGENT_TOKEN', 500);
}
if (!is_string($token) || $token === '' || !hash_equals(PCMS_AGENT_TOKEN, $token)) {
    pcms_fail('bad token', 401);
}
if (PCMS_AGENT_ALLOWED_IPS !== [] && !in_array($_SERVER['REMOTE_ADDR'] ?? '', PCMS_AGENT_ALLOWED_IPS, true)) {
    pcms_fail('ip not allowed', 403);
}

$action = $_GET['action'] ?? '';
if (!is_string($action) || !preg_match('/^[a-z-]+$/', $action)) {
    pcms_fail('action required');
}

// Bootstrap the real MODX API (works on 2.x and 3.x; 3.x keeps the BC shim).
define('MODX_API_MODE', true);
require_once __DIR__ . '/config.core.php';
require_once MODX_CORE_PATH . 'model/modx/modx.class.php';
$modx = new modX();
$modx->initialize('web');

function pcms_table_exists(modX $modx, string $tableName): bool
{
    try {
        $stmt = $modx->prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?');
        $stmt->execute([$tableName]);
        return (bool) $stmt->fetchColumn();
    } catch (Throwable $e) {
        return false;
    }
}

/** Table name with the site's configured prefix. */
function pcms_prefixed(string $bare): string
{
    global $modx;
    return $modx->getOption('table_prefix') . $bare;
}

try {
    switch ($action) {
        case 'info':
            $version = $modx->getVersionData();
            $contentTypes = [];
            $query = $modx->newQuery('modContentType');
            foreach ($modx->getIterator('modContentType', $query) as $type) {
                $contentTypes[] = [
                    'id' => (int) $type->get('id'),
                    'name' => (string) $type->get('name'),
                    'mime_type' => (string) $type->get('mime_type'),
                    'file_extension' => (string) $type->get('file_extension'),
                ];
            }
            $migxTvs = 0;
            $tvQuery = $modx->newQuery('modTemplateVar', ['type' => 'migx']);
            $migxTvs = $modx->getCount('modTemplateVar', $tvQuery);
            $extras = [
                'migx' => $migxTvs > 0,
                'migx_tv_count' => $migxTvs,
                'gallery' => pcms_table_exists($modx, pcms_prefixed('gallery_items')),
                'seosuite' => pcms_table_exists($modx, pcms_prefixed('seosuite_redirects')),
                'seosuite_alt' => pcms_table_exists($modx, pcms_prefixed('seosuite_urls')),
            ];
            pcms_respond([
                'ok' => true,
                'agent' => 'pcms-migration-agent/1.0',
                'modx_version' => $version['version'] ?? null,
                'product' => $version['product'] ?? null,
                'settings' => [
                    'site_url' => (string) $modx->getOption('site_url'),
                    'base_url' => (string) $modx->getOption('base_url'),
                    'friendly_urls' => (bool) $modx->getOption('friendly_urls', null, false),
                    'use_alias_path' => (bool) $modx->getOption('use_alias_path', null, false),
                    'container_suffix' => (string) $modx->getOption('container_suffix', null, '/'),
                    'default_template' => (int) $modx->getOption('default_template', null, 0),
                    'site_start' => (int) $modx->getOption('site_start', null, 1),
                ],
                'content_types' => $contentTypes,
                'extras' => $extras,
            ]);
            // no break — handled by exit in pcms_respond

        case 'tvs':
            $out = [];
            foreach ($modx->getIterator('modTemplateVar') as $tv) {
                $out[] = [
                    'id' => (int) $tv->get('id'),
                    'name' => (string) $tv->get('name'),
                    'caption' => (string) $tv->get('caption'),
                    'type' => (string) $tv->get('type'),
                ];
            }
            pcms_respond(['ok' => true, 'tvs' => $out]);

        case 'resources':
            $offset = max(0, (int) ($_GET['offset'] ?? 0));
            $limit = min(PCMS_AGENT_MAX_LIMIT, max(1, (int) ($_GET['limit'] ?? 500)));
            $criteria = ['context_key' => 'web'];
            $total = $modx->getCount('modResource', $criteria);
            $query = $modx->newQuery('modResource', $criteria);
            $query->sortby('id', 'ASC');
            $query->limit($limit, $offset);
            $resources = [];
            foreach ($modx->getIterator('modResource', $query) as $resource) {
                $tvs = [];
                foreach ($resource->getMany('TemplateVars') as $tv) {
                    $tvs[] = [
                        'id' => (int) $tv->get('id'),
                        'name' => (string) $tv->get('name'),
                        'type' => (string) $tv->get('type'),
                        'value' => (string) $resource->getValue($tv->get('id')),
                    ];
                }
                $resources[] = [
                    'id' => (int) $resource->get('id'),
                    'parent' => (int) $resource->get('parent'),
                    'template' => (int) $resource->get('template'),
                    'content_type' => (int) $resource->get('content_type'),
                    'class_key' => (string) $resource->get('class_key'),
                    'context_key' => (string) $resource->get('context_key'),
                    'alias' => (string) $resource->get('alias'),
                    'uri' => (string) $resource->get('uri'),
                    'uri_override' => (int) $resource->get('uri_override'),
                    'pagetitle' => (string) $resource->get('pagetitle'),
                    'longtitle' => (string) $resource->get('longtitle'),
                    'description' => (string) $resource->get('description'),
                    'introtext' => (string) $resource->get('introtext'),
                    'content' => (string) $resource->get('content'),
                    'menutitle' => (string) $resource->get('menutitle'),
                    'menuindex' => (int) $resource->get('menuindex'),
                    'published' => (int) $resource->get('published'),
                    'deleted' => (int) $resource->get('deleted'),
                    'isfolder' => (int) $resource->get('isfolder'),
                    'createdon' => (string) $resource->get('createdon'),
                    'editedon' => (string) $resource->get('editedon'),
                    'tvs' => $tvs,
                ];
            }
            pcms_respond([
                'ok' => true,
                'total' => $total,
                'offset' => $offset,
                'limit' => $limit,
                'resources' => $resources,
            ]);

        case 'media-sources':
            $out = [];
            foreach ($modx->getIterator('modMediaSource') as $source) {
                $properties = $source->get('properties');
                if (is_string($properties)) {
                    $decoded = json_decode($properties, true);
                    $properties = is_array($decoded) ? $decoded : [];
                }
                // MODX stores source config as {name: {name, value, ...}}.
                $pick = static function (string $key) use ($properties): string {
                    $entry = $properties[$key] ?? null;
                    if (is_array($entry)) {
                        return (string) ($entry['value'] ?? '');
                    }
                    return is_string($entry) ? $entry : '';
                };
                $out[] = [
                    'id' => (int) $source->get('id'),
                    'name' => (string) $source->get('name'),
                    'class_key' => (string) $source->get('class_key'),
                    'is_stream' => ((int) $source->get('is_stream')) === 1,
                    'base_path' => $pick('basePath'),
                    'base_url' => $pick('baseUrl'),
                ];
            }
            pcms_respond(['ok' => true, 'sources' => $out]);

        case 'media-files':
            $sourceId = (int) ($_GET['source'] ?? 0);
            $offset = max(0, (int) ($_GET['offset'] ?? 0));
            $limit = min(2000, max(1, (int) ($_GET['limit'] ?? 2000)));
            $source = $modx->getObject('modMediaSource', $sourceId);
            if ($source === null) {
                pcms_fail('media source not found', 404);
            }
            /** @var modMediaSource $source */
            if (!$source->initialize()) {
                pcms_fail('media source init failed', 500);
            }
            $basePath = $source->getBasePath();
            $baseUrl = $source->getBaseUrl();
            $files = [];
            $scanned = 0;
            $pattern = '/\.(jpe?g|png|gif|webp|svg|pdf|mp4)$/i';
            if (is_string($basePath) && $basePath !== '' && is_dir($basePath)) {
                $iterator = new RecursiveIteratorIterator(
                    new RecursiveDirectoryIterator($basePath, FilesystemIterator::SKIP_DOTS),
                    RecursiveIteratorIterator::LEAVES_ONLY
                );
                foreach ($iterator as $fileInfo) {
                    /** @var SplFileInfo $fileInfo */
                    if (!$fileInfo->isFile() || !preg_match($pattern, $fileInfo->getFilename())) {
                        continue;
                    }
                    $scanned++;
                    if ($scanned > PCMS_AGENT_MAX_FILE_LIST) {
                        break;
                    }
                    $relative = substr($fileInfo->getPathname(), strlen($basePath));
                    $files[] = str_replace('\\', '/', ltrim($relative, '/\\'));
                }
            }
            sort($files);
            $page = array_slice($files, $offset, $limit);
            pcms_respond([
                'ok' => true,
                'source' => $sourceId,
                'base_url' => (string) $baseUrl,
                'base_path_set' => $basePath !== '' && $basePath !== false,
                'total_scanned' => $scanned,
                'capped' => $scanned > PCMS_AGENT_MAX_FILE_LIST,
                'offset' => $offset,
                'files' => $page,
            ]);

        case 'redirects':
            // SEO Suite redirect history, if installed — pre-seeds our plan.
            $found = null;
            foreach ([pcms_prefixed('seosuite_redirects'), pcms_prefixed('seosuite_urls')] as $candidate) {
                if (pcms_table_exists($modx, $candidate)) {
                    $found = $candidate;
                    break;
                }
            }
            if ($found === null) {
                pcms_respond(['ok' => true, 'table' => null, 'redirects' => []]);
            }
            $stmt = $modx->prepare("SELECT * FROM `{$found}` LIMIT 5000");
            $stmt->execute();
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            pcms_respond(['ok' => true, 'table' => $found, 'redirects' => $rows]);

        default:
            pcms_fail("unknown action '{$action}'", 404);
    }
} catch (Throwable $error) {
    pcms_fail('agent error: ' . $error->getMessage(), 500);
}
