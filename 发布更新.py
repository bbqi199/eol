"""
一键发布脚本
功能：自动找最新Excel导入模板 → 生成 goods.json → 推送到GitHub
用法：双击运行，或在命令行执行 python 发布更新.py
"""
import json, os, glob, subprocess, sys, io
from datetime import datetime

# 修复Windows控制台中文输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ===== 第一步：找本文件夹中包含"导入"关键字的Excel文件 =====
xlsx_files = glob.glob('*.xlsx')
xlsx_files = [f for f in xlsx_files if not f.startswith('~$')]

if not xlsx_files:
    print('❌ 未找到 Excel 文件！')
    input('按回车键退出...')
    sys.exit(1)

# 优先选择包含"导入"关键字的文件
import_files = [f for f in xlsx_files if '导入' in f]
if import_files:
    EXCEL_FILE = import_files[0]
else:
    EXCEL_FILE = xlsx_files[0]

print(f'📂 已选择: {EXCEL_FILE}')

# ===== 第二步：读取Excel，转换商品数据 =====
try:
    import openpyxl
except ImportError:
    print('❌ 需要 openpyxl 库，请运行: pip install openpyxl')
    input('按回车键退出...')
    sys.exit(1)

try:
    wb = openpyxl.load_workbook(EXCEL_FILE, data_only=True)
    ws = wb['商品数据']
    
    goods = []
    row_num = 0
    for row in ws.iter_rows(min_row=2):  # 跳过标题行
        row_num += 1
        
        # A=0(编号), B=1(分类), C=2(名称), D=3(规格), E=4(单价), F=5(单位), G=6(库存)
        # H=7(标签), I=8(图标), J=9(规格选项), K=10(属性), L=11(图片)
        id_cell = row[0]
        id_val = str(id_cell.value).strip() if id_cell.value is not None else ''
        
        # 去掉可能的浮点尾部（如 90.0 → 90）
        if '.' in id_val:
            id_val = id_val.rstrip('0').rstrip('.')
        
        # 跳过空行和模板示例行
        if not id_val or id_val == 'None' or '必填' in id_val or id_val.startswith('例：'):
            continue
        
        # 处理标签
        tags = []
        if row[7].value:
            tags = [t.strip() for t in str(row[7].value).split(',') if t.strip()]
        
        # 处理规格选项
        specs = []
        if row[9].value:
            specs = [s.strip() for s in str(row[9].value).split('|') if s.strip()]
        
        # 处理属性键值对
        attrs = {}
        if row[10].value:
            for pair in str(row[10].value).split('|'):
                if ':' in pair:
                    k, v = pair.split(':', 1)
                    attrs[k.strip()] = v.strip()
        
        # 处理图片URL
        img = str(row[11].value).strip() if row[11].value else ''
        img = img.replace('/images/', 'images/')
        
        # 处理分类ID
        try:
            cat_id = int(float(row[1].value)) if row[1].value else 0
        except:
            cat_id = 0
        
        # 处理价格
        try:
            price = float(row[4].value) if row[4].value else 0
        except:
            price = 0
        
        # 处理库存
        try:
            stock = int(float(row[6].value)) if row[6].value else 999
        except:
            stock = 999
        
        g = {
            'id':       id_val,
            'catId':    cat_id,
            'emoji':    str(row[8].value).strip() if row[8].value else '📦',
            'name':     str(row[2].value).strip() if row[2].value else '',
            'spec':     str(row[3].value).strip() if row[3].value else '',
            'price':    price,
            'unit':     str(row[5].value).strip() if row[5].value else '',
            'stock':    stock,
            'tag':      tags,
            'attrs':    attrs,
            'specs':    specs,
            'imageUrl': img
        }
        goods.append(g)
    
    wb.close()
    print(f'✅ 读取完成：共 {len(goods)} 件商品')
    
except Exception as e:
    print(f'❌ 读取Excel出错：{e}')
    input('按回车键退出...')
    sys.exit(1)

# ===== 第三步：写入 goods.json =====
goods_json_str = json.dumps(goods, ensure_ascii=False, indent=None, separators=(',', ':'))

with open('goods.json', 'w', encoding='utf-8') as f:
    f.write(goods_json_str)

print(f'✅ 商品数据已写入 goods.json（共 {len(goods)} 件）')

# ===== 第四步：git add、commit、push =====
now = datetime.now().strftime('%Y-%m-%d %H:%M')
commit_msg = f'更新商品数据 {now}（共{len(goods)}件）'

try:
    # 添加 goods.json
    subprocess.run(['git', 'add', '-f', 'goods.json'], check=True)
    
    # 提交
    subprocess.run(['git', 'commit', '-m', commit_msg], check=True)
    
    # 推送
    print('📤 推送到GitHub...')
    subprocess.run(['git', 'push', 'origin', 'main'], check=True)
    
    print(f'\n🎉 发布成功！约1-2分钟后线上同步。')
    print(f'   线上地址：https://bbqi199.github.io/ECO-SHOP/')
except subprocess.CalledProcessError as e:
    print(f'❌ git操作失败：{e}')

input('\n按回车键退出...')
