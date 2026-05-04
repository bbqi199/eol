/**
 * =====================================================
 *  ECO-SHOP 订单接收 + 商家回复通知 — Google Apps Script
 * =====================================================
 *
 *  【核心功能】
 *  1. 接收前端订单写入 Google Sheets
 *  2. 商家在表格改「状态」「商家留言」列 → 客户刷新页面自动收到通知
 *
 *  【部署步骤】
 *  1. 打开 Google Sheets，新建一个表格
 *  2. 点击「扩展程序」→「Apps Script」
 *  3. 删除编辑器中的默认代码，将本文件全部内容粘贴进去
 *  4. 点击「部署」→「新建部署」
 *     - 类型：选择「Web 应用」
 *     - 执行身份：我（你的 Google 账号）
 *     - 谁可以访问：所有人
 *  5. 部署后复制「Web 应用 URL」
 *  6. 将 URL 粘贴到 index.html 中的 GSHEET_URL 变量里
 *
 *  【表格 Sheet 说明】
 *  - "Orders"：订单汇总（一笔订单一行）
 *    列：订单号 | 下单时间 | 买家姓名 | 买家电话 | 收货地址 | 备注 | 总额 | 商品数量 | 同步时间 | 状态 | 商家留言 | 更新时间
 *  - "Items"：商品明细（每个商品一行）
 *  - "Log"：操作日志
 *
 *  【商家操作方式（在 Google Sheets 里）】
 *  - 修改「状态」列：pending / processing / done / cancelled
 *    对应显示：In attesa / In preparazione / Completati / Annullato
 *  - 修改「商家留言」列：填写回复内容
 *  - 客户刷新页面后，自动读取最新状态和留言并弹窗通知
 *
 *  =====================================================
 */

/* ====================================================
   配置区
   ==================================================== */
var CONFIG = {
  // ⚠️ 重要：填写你的 Google Sheets 表格 ID（地址栏 /d/ 后面那串）
  // 地址格式：https://docs.google.com/spreadsheets/d/【这串ID】/edit
  SPREADSHEET_ID: '1VccQwfA7QEqYKNkkvlTbvOfNjr51m-OkazaO9VpPKIs',

  SHEET_ORDERS: 'Orders',
  SHEET_ITEMS:  'Items',
  SHEET_LOG:    'Log',

  // Orders 表头（新增了 状态、商家留言、更新时间）
  ORDER_HEADERS: [
    '订单号',        // A
    '下单时间',      // B
    '买家姓名',      // C
    '买家电话',      // D
    '收货地址',      // E
    '备注',          // F
    '订单总额(€)',   // G
    '商品数量',      // H
    '同步时间',      // I
    '状态',          // J  ← 商家在这里改
    '商家留言',      // K  ← 商家在这里回复
    '更新时间'       // L  ← 自动更新
  ],

  // Items 表头
  ITEM_HEADERS: [
    '订单号',
    '商品编码',
    '商品名称',
    '规格',
    '标签',
    '箱数',
    '单箱价格(€)',
    '总金额(€)'
  ],

  // 状态映射（表格里写中文也行）
  STATUS_MAP: {
    '待处理': 'pending', 'in attesa': 'pending', 'pending': 'pending',
    '处理中': 'processing', 'in preparazione': 'processing', 'processing': 'processing',
    '已完成': 'done', 'completati': 'done', 'done': 'done',
    '已取消': 'cancelled', 'annullato': 'cancelled', 'cancelled': 'cancelled'
  }
};

/* ====================================================
   Web App 入口
   ==================================================== */
function doGet(e) {
  try {
    var action = (e.parameter.action || '').toLowerCase();

    switch (action) {
      case 'readorders':
        return jsonRes(readOrders(e));

      case 'readitems':
        return jsonRes(readItems(e));

      case 'deleteorder':
        return jsonRes(deleteOrder(e));

      case 'clearall':
        return jsonRes(clearAllData());

      default:
        // 无 action → 处理写入订单
        if (e.parameter.data) {
          return jsonRes(handleOrderSubmit(e));
        }
        return jsonRes({ status: 'ok', message: 'ECO-SHOP API Running. Use ?action=readOrders to get orders.' });
    }
  } catch (err) {
    log('ERROR', err.toString());
    return jsonRes({ status: 'error', message: err.toString() });
  }
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    return jsonRes(handleOrderSubmit(payload));
  } catch (err) {
    log('ERROR', 'POST: ' + err.toString());
    return jsonRes({ status: 'error', message: err.toString() });
  }
}

/* ====================================================
   核心：写入订单
   ==================================================== */
function handleOrderSubmit(e) {
  var data = e.parameter.data ? JSON.parse(e.parameter.data) : (e.data || e);

  if (!data || !data.items || data.items.length === 0) {
    return { status: 'error', message: '没有订单数据' };
  }

  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  ensureSheet(ss, CONFIG.SHEET_ORDERS, CONFIG.ORDER_HEADERS);
  ensureSheet(ss, CONFIG.SHEET_ITEMS,  CONFIG.ITEM_HEADERS);

  // 写入订单汇总行
  var orderSheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);
  var now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  var orderRow = [
    data.order_no    || '',
    data.order_time  || '',
    data.buyer_name  || '',
    data.buyer_phone || '',
    data.address     || '',
    data.remark      || '',
    data.total       || 0,
    data.items.length,
    now,
    'pending',       // 初始状态
    '',              // 商家留言
    now              // 更新时间
  ];
  orderSheet.appendRow(orderRow);
  autoResize(orderSheet);

  // 写入商品明细
  var itemSheet = ss.getSheetByName(CONFIG.SHEET_ITEMS);
  var items = data.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    itemSheet.appendRow([
      data.order_no     || '',
      item.item_no      || '',
      item.item_name    || '',
      item.item_spec    || '',
      item.item_label   || '',
      item.item_qty     || 0,
      item.item_price   || 0,
      item.item_amount  || 0
    ]);
  }
  autoResize(itemSheet);

  log('ORDER', '订单号: ' + (data.order_no || '') + ', 商品数: ' + items.length + ', 总额: €' + (data.total || 0));

  return {
    status: 'success',
    message: '订单 ' + (data.order_no || '') + ' 已写入表格',
    order_no: data.order_no
  };
}

/* ====================================================
   读取订单（含状态 + 商家留言）
   前端通过 readOrders 获取，合并到本地订单显示
   ==================================================== */
function readOrders(e) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);
  if (!sheet) return { orders: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { orders: [] };

  var headers = data[0];
  var orders = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;

    // 读取状态列（第10列，索引9），规范化状态值
    var rawStatus = String(row[9] || 'pending').toLowerCase().trim();
    var normalizedStatus = CONFIG.STATUS_MAP[rawStatus] || rawStatus;

    orders.push({
      order_no:       row[0] || '',
      order_time:     row[1] || '',
      buyer_name:     row[2] || '',
      buyer_phone:    row[3] || '',
      address:        row[4] || '',
      remark:         row[5] || '',
      total:          row[6] || 0,
      item_count:     row[7] || 0,
      sync_time:      row[8] || '',
      status:         normalizedStatus,
      merchant_note:  String(row[10] || ''),
      last_update:    row[11] || ''
    });
  }

  return { orders: orders, total: orders.length };
}

/* ====================================================
   读取商品明细
   ==================================================== */
function readItems(e) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_ITEMS);
  if (!sheet) return { items: [] };

  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { items: [] };

  var headers = data[0];
  var items = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var item = {};
    for (var j = 0; j < headers.length; j++) {
      item[headers[j]] = row[j];
    }
    items.push(item);
  }

  return { items: items, total: items.length };
}

/* ====================================================
   删除订单
   ==================================================== */
function deleteOrder(e) {
  var orderNo = e.parameter.order_no || '';
  if (!orderNo) return { status: 'error', message: '缺少 order_no 参数' };

  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  var orderSheet = ss.getSheetByName(CONFIG.SHEET_ORDERS);
  if (orderSheet) {
    var orderData = orderSheet.getDataRange().getValues();
    for (var i = orderData.length - 1; i >= 1; i--) {
      if (orderData[i][0] == orderNo) orderSheet.deleteRow(i + 1);
    }
  }

  var itemSheet = ss.getSheetByName(CONFIG.SHEET_ITEMS);
  if (itemSheet) {
    var itemData = itemSheet.getDataRange().getValues();
    for (var i = itemData.length - 1; i >= 1; i--) {
      if (itemData[i][0] == orderNo) itemSheet.deleteRow(i + 1);
    }
  }

  log('DELETE', '已删除订单: ' + orderNo);
  return { status: 'success', message: '订单 ' + orderNo + ' 已删除' };
}

/* ====================================================
   清空所有数据
   ==================================================== */
function clearAllData() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  [CONFIG.SHEET_ORDERS, CONFIG.SHEET_ITEMS, CONFIG.SHEET_LOG].forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
  });
  log('CLEAR', '所有数据已清空');
  return { status: 'success', message: '所有数据已清空' };
}

/* ====================================================
   工具函数
   ==================================================== */

function ensureSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#4a86e8')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#4a86e8')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

function autoResize(sheet) {
  var lastCol = sheet.getLastColumn();
  for (var c = 1; c <= lastCol; c++) sheet.autoResizeColumn(c);
}

function log(type, message) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_LOG);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_LOG);
    sheet.appendRow(['时间', '类型', '内容']);
    sheet.getRange(1, 1, 1, 3)
      .setFontWeight('bold')
      .setBackground('#f6b26b')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([
    new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }),
    type,
    message
  ]);
}

function jsonRes(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ====================================================
   可选：onEdit 触发器
   当商家修改 Orders 表的「状态」或「商家留言」时，
   自动在「更新时间」列写入当前时间
   ====================================================
   设置方式：
   Apps Script 编辑器 → 触发器 → 添加触发器
   - 函数：onOrderEdit
   - 事件来源：从电子表格
   - 事件类型：编辑时
   ==================================================== */
function onOrderEdit(e) {
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== CONFIG.SHEET_ORDERS) return;

  var row = e.range.getRow();
  var col = e.range.getColumn();

  // 状态列 = J(10)，商家留言列 = K(11)，更新时间列 = L(12)
  if (row > 1 && (col === 10 || col === 11)) {
    var now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    sheet.getRange(row, 12).setValue(now);

    // 同时规范化状态值
    if (col === 10) {
      var rawVal = String(e.value || '').toLowerCase().trim();
      var normalized = CONFIG.STATUS_MAP[rawVal];
      if (normalized) {
        sheet.getRange(row, 10).setValue(normalized);
      }
    }

    log('EDIT', '行 ' + row + ' 的列 ' + col + ' 被修改');
  }
}

/* ====================================================
   定时清理日志（可选）
   在触发器中设置每天执行 cleanOldLogs
   ==================================================== */
function cleanOldLogs() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.SHEET_LOG);
  if (!sheet || sheet.getLastRow() <= 1) return;

  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  var data = sheet.getDataRange().getValues();
  var rowsToDelete = [];

  for (var i = data.length - 1; i >= 1; i--) {
    var timeStr = data[i][0];
    if (timeStr) {
      var parts = timeStr.split(/[\/: ]/);
      if (parts.length >= 6) {
        var rowDate = new Date(parts[2], parts[1] - 1, parts[0], parts[3], parts[4], parts[5]);
        if (rowDate < cutoff) rowsToDelete.push(i + 1);
      }
    }
  }

  for (var i = 0; i < rowsToDelete.length; i++) {
    sheet.deleteRow(rowsToDelete[i]);
  }

  if (rowsToDelete.length > 0) {
    log('CLEANUP', '已清理 ' + rowsToDelete.length + ' 条过期日志');
  }
}
