<?php
/**
 * pcms-agent.php — Progressive CMS migration agent for 1C-Bitrix.
 *
 * Same contract as the MODX agent: one PHP file in the site web root,
 * token-authenticated, read-only, native kernel API (no DB creds leave the
 * site). Bitrix content lives in information blocks; element URLs depend on
 * the site's SEF templates, so the agent exports the raw materials and the
 * PCMS side composes paths from an operator-supplied URL template.
 *
 * Install:
 *   1. Copy into the Bitrix web root (next to index.php).
 *   2. Set PCMS_AGENT_TOKEN.
 *   3. HTTPS only; delete after the migration.
 *
 * Actions (header X-PCMS-Agent-Token):
 *   ?action=info        — version, iblock inventory, modules
 *   ?action=iblock&id=N — sections + elements of one information block
 *   ?action=files       — /upload/ file inventory (images/docs, capped)
 *   ?action=redirects   — known redirect data if a redirect module table exists
 */

declare(strict_types=1);

const PCMS_AGENT_TOKEN = 'CHANGE_ME_TO_A_LONG_RANDOM_STRING';
const PCMS_AGENT_ALLOWED_IPS = [];
const PCMS_AGENT_MAX_ELEMENT_PAGES = 200;

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

// Bootstrap the Bitrix kernel (prolog_before without the full page render).
define('NO_KEEP_STATISTIC', true);
define('NOT_CHECK_PERMISSIONS', true);
define('STOP_STATISTICS', true);
define('NO_AGENT_CHECK', true);
require_once $_SERVER['DOCUMENT_ROOT'] . '/bitrix/modules/main/include/prolog_before.php';

if (!CModule::IncludeModule('iblock')) {
    pcms_fail('iblock module is not installed', 500);
}

try {
    switch ($action) {
        case 'info':
            $iblocks = [];
            $rs = CIBlock::GetList([], ['ACTIVE' => 'Y']);
            while ($iblock = $rs->Fetch()) {
                $elementsCount = CIBlockElement::GetList([], ['IBLOCK_ID' => (int) $iblock['ID']], false, false, ['ID']);
                $iblocks[] = [
                    'id' => (int) $iblock['ID'],
                    'code' => (string) $iblock['CODE'],
                    'name' => (string) $iblock['NAME'],
                    'iblock_type_id' => (string) $iblock['IBLOCK_TYPE_ID'],
                    'site_id' => (string) $iblock['SITE_ID'],
                    'elements' => (int) $elementsCount->SelectedRowsCount(),
                ];
            }
            pcms_respond([
                'ok' => true,
                'agent' => 'pcms-migration-agent-bitrix/1.0',
                'bitrix_version' => defined('SM_VERSION') ? SM_VERSION : null,
                'site_url' => (string) (( $_SERVER['REQUEST_SCHEME'] ?? 'https' ) . '://' . ( $_SERVER['HTTP_HOST'] ?? '' )),
                'iblocks' => $iblocks,
            ]);

        case 'iblock':
            $iblockId = (int) ($_GET['id'] ?? 0);
            $page = max(1, (int) ($_GET['page'] ?? 1));
            $perPage = 200;
            if ($iblockId <= 0 || $page > PCMS_AGENT_MAX_ELEMENT_PAGES) {
                pcms_fail('bad iblock id or page', 400);
            }

            $sections = [];
            $rs = CIBlockSection::GetList(
                ['left_margin' => 'ASC'],
                ['IBLOCK_ID' => $iblockId, 'ACTIVE' => 'Y'],
                false,
                ['ID', 'IBLOCK_SECTION_ID', 'NAME', 'CODE', 'SECTION_PAGE_URL', 'DEPTH_LEVEL', 'ACTIVE']
            );
            while ($section = $rs->GetNext()) {
                $sections[] = [
                    'id' => (int) $section['ID'],
                    'parent' => (int) $section['IBLOCK_SECTION_ID'],
                    'name' => (string) $section['NAME'],
                    'code' => (string) $section['CODE'],
                    'url' => (string) $section['SECTION_PAGE_URL'],
                    'depth' => (int) $section['DEPTH_LEVEL'],
                ];
            }

            $elements = [];
            $rs = CIBlockElement::GetList(
                ['ID' => 'ASC'],
                ['IBLOCK_ID' => $iblockId],
                false,
                ['iNumPage' => $page, 'nPageSize' => $perPage],
                ['ID', 'IBLOCK_SECTION_ID', 'NAME', 'CODE', 'DETAIL_PAGE_URL', 'ACTIVE', 'DETAIL_TEXT', 'PREVIEW_TEXT', 'ACTIVE_FROM']
            );
            while ($element = $rs->GetNextElement()) {
                $fields = $element->GetFields();
                $properties = [];
                foreach ($element->GetProperties() as $code => $property) {
                    $properties[] = [
                        'code' => (string) $code,
                        'name' => (string) $property['NAME'],
                        'type' => (string) $property['PROPERTY_TYPE'],
                        'value' => $property['VALUE'],
                    ];
                }
                $elements[] = [
                    'id' => (int) $fields['ID'],
                    'section' => (int) $fields['IBLOCK_SECTION_ID'],
                    'name' => (string) $fields['NAME'],
                    'code' => (string) $fields['CODE'],
                    'url' => (string) $fields['DETAIL_PAGE_URL'],
                    'active' => $fields['ACTIVE'] === 'Y',
                    'detail_text' => (string) $fields['DETAIL_TEXT'],
                    'preview_text' => (string) $fields['PREVIEW_TEXT'],
                    'properties' => $properties,
                ];
            }
            pcms_respond([
                'ok' => true,
                'iblock' => $iblockId,
                'page' => $page,
                'sections' => $sections,
                'elements' => $elements,
            ]);

        case 'files':
            $offset = max(0, (int) ($_GET['offset'] ?? 0));
            $limit = min(2000, max(1, (int) ($_GET['limit'] ?? 2000)));
            $uploadRoot = $_SERVER['DOCUMENT_ROOT'] . '/upload/';
            $files = [];
            if (is_dir($uploadRoot)) {
                $iterator = new RecursiveIteratorIterator(
                    new RecursiveDirectoryIterator($uploadRoot, FilesystemIterator::SKIP_DOTS),
                    RecursiveIteratorIterator::LEAVES_ONLY
                );
                $all = [];
                foreach ($iterator as $fileInfo) {
                    /** @var SplFileInfo $fileInfo */
                    if (!$fileInfo->isFile() || !preg_match('/\.(jpe?g|png|gif|webp|svg|pdf)$/i', $fileInfo->getFilename())) {
                        continue;
                    }
                    $all[] = str_replace('\\', '/', substr($fileInfo->getPathname(), strlen($_SERVER['DOCUMENT_ROOT'])));
                }
                sort($all);
                $files = array_slice($all, $offset, $limit);
                pcms_respond([
                    'ok' => true,
                    'total' => count($all),
                    'offset' => $offset,
                    'files' => $files,
                ]);
            }
            pcms_respond(['ok' => true, 'total' => 0, 'offset' => $offset, 'files' => []]);

        case 'redirects':
            // No first-party redirect store in stock Bitrix; SEO modules vary.
            pcms_respond(['ok' => true, 'redirects' => []]);

        default:
            pcms_fail("unknown action '{$action}'", 404);
    }
} catch (Throwable $error) {
    pcms_fail('agent error: ' . $error->getMessage(), 500);
}
