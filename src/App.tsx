import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Camera, Upload, Image as ImageIcon, Loader2, Calculator, RefreshCw, Trash2, History, X, CheckCircle2, AlertCircle, LogIn, LogOut, Save, Edit3, Maximize2, ZoomIn, Settings, Key, FileText, ChevronLeft, ChevronRight, MessageCircle, Send, Bot, User as UserIcon, ArrowUp, Package, Plus, Search, PlusCircle, ChevronDown, Filter } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LuckyCat from './components/LuckyCat';
import Logo from './components/Logo';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { GoogleGenAI, Type } from "@google/genai";
import { cn } from './lib/utils';
import * as XLSX from 'xlsx';

// Firebase imports
import { auth, db } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  deleteDoc, 
  doc, 
  updateDoc,
  serverTimestamp,
  getDocFromServer,
  limit,
  getDocs
} from 'firebase/firestore';

// Initialize Gemini helper
const getAI = (manualKey?: string, serverKey?: string | null) => {
  let apiKey = '';
  
  const isValid = (key: any) => typeof key === 'string' && key.length > 10 && key !== 'undefined' && key !== 'null';

  // 1. Try manual key from settings
  if (isValid(manualKey)) {
    apiKey = manualKey!;
  }
  
  // 2. Try server-provided key (from process.env on server)
  if (!apiKey && isValid(serverKey)) {
    apiKey = serverKey!;
  }

  // 3. Try process.env in frontend (if injected by build)
  if (!apiKey) {
    try {
      // @ts-ignore
      const envKey = process.env.GEMINI_API_KEY;
      // @ts-ignore
      const pKey = process.env.API_KEY;
      if (isValid(envKey)) apiKey = envKey;
      else if (isValid(pKey)) apiKey = pKey;
    } catch (e) {}
  }

  // 4. Try Vite env vars
  if (!apiKey) {
    try {
      const vGemini = (import.meta as any).env?.VITE_GEMINI_API_KEY;
      const vApi = (import.meta as any).env?.VITE_API_KEY;
      if (isValid(vGemini)) apiKey = vGemini;
      else if (isValid(vApi)) apiKey = vApi;
    } catch (e) {}
  }

  if (!apiKey) {
    console.warn("No valid API Key found.");
    return null;
  }
  
  return new GoogleGenAI({ apiKey });
};

// Type definition for AI Studio window API
declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

interface HistoryItem {
  id: string;
  uid: string;
  image?: string;
  images?: string[];
  result: string;
  correction?: string;
  timestamp: any;
  status?: 'processing' | 'completed' | 'failed';
}

interface Product {
  id: string;
  uid: string;
  name: string;
  price: number;
  wholesalePrice?: number;
  size?: string;
  thickness?: string;
  unit?: string;
  attributes?: Record<string, string>;
  description?: string;
  category?: string;
  createdAt: any;
  updatedAt?: any;
}

interface Adjustment {
  description: string;
  type: 'add' | 'subtract';
  amount: number;
}

interface InvoiceData {
  isCorrect: boolean;
  items: {
    name: string;
    quantity: number;
    unitPrice: number;
    calculatedTotal: number;
    billTotal?: number;
    isCorrect: boolean;
  }[];
  summary: {
    billTotal?: number;
    calculatedTotal: number;
    adjustments: Adjustment[];
    finalCalculatedTotal: number;
    finalBillTotal?: number;
  };
}

interface InvoiceResult {
  invoices: InvoiceData[];
}

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount).replace('₫', 'đ');
};

const InvoiceResultRenderer = ({ data, onChange }: { data: string, onChange?: (newData: string) => void }) => {
  if (!data || data === '') {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader2 className="animate-spin text-rose-500" size={48} strokeWidth={1.5} />
        <p className="text-[#666] font-medium animate-pulse">Đang phân tích dữ liệu hóa đơn...</p>
        <p className="text-xs text-[#999]">Sếp có thể tắt app, kết quả sẽ tự động cập nhật vào lịch sử.</p>
      </div>
    );
  }

  let resultData: InvoiceResult | null = null;
  
  try {
    // Try to parse as JSON
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object') {
      if ('invoices' in parsed && Array.isArray(parsed.invoices)) {
        resultData = parsed;
      } else if ('items' in parsed && 'summary' in parsed) {
        // Fallback for old single invoice format
        resultData = { invoices: [parsed] };
      }
    }
  } catch (e) {
    // Not JSON, fallback to Markdown
  }

  const handleItemChange = (invoiceIdx: number, itemIdx: number, field: 'name' | 'quantity' | 'unitPrice', value: string) => {
    if (!resultData || !onChange) return;
    
    const newData = JSON.parse(JSON.stringify(resultData)) as InvoiceResult;
    const invoice = newData.invoices[invoiceIdx];
    
    if (field === 'name') {
      invoice.items[itemIdx][field] = value;
    } else {
      const numValue = parseFloat(value) || 0;
      invoice.items[itemIdx][field] = numValue;
    }
    
    // Recalculate item total
    invoice.items[itemIdx].calculatedTotal = invoice.items[itemIdx].quantity * invoice.items[itemIdx].unitPrice;
    
    // Check if it matches billTotal
    if (invoice.items[itemIdx].billTotal !== undefined) {
      invoice.items[itemIdx].isCorrect = invoice.items[itemIdx].calculatedTotal === invoice.items[itemIdx].billTotal;
    }

    // Recalculate summary totals
    invoice.summary.calculatedTotal = invoice.items.reduce((sum, item) => sum + item.calculatedTotal, 0);
    
    // Recalculate final total
    let finalCalc = invoice.summary.calculatedTotal;
    invoice.summary.adjustments.forEach(adj => {
      if (adj.type === 'add') finalCalc += adj.amount;
      else if (adj.type === 'subtract') finalCalc -= adj.amount;
    });
    invoice.summary.finalCalculatedTotal = finalCalc;

    // Recalculate overall isCorrect
    const isSubTotalCorrect = invoice.summary.billTotal === undefined || invoice.summary.calculatedTotal === invoice.summary.billTotal;
    const isFinalTotalCorrect = invoice.summary.finalBillTotal === undefined || invoice.summary.finalCalculatedTotal === invoice.summary.finalBillTotal;
    const isItemsCorrect = invoice.items.every(item => item.isCorrect);

    invoice.isCorrect = isItemsCorrect && isSubTotalCorrect && isFinalTotalCorrect;

    onChange(JSON.stringify(newData, null, 2));
  };

  if (!resultData) {
    if (data === "Ui ui đây không phải hóa đơn Sếp ơi, Sếp uống mấy lon Bia rồi Sếp, nghỉ đi Sếp ơiiii ! ") {
      return (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 p-6 rounded-[24px] flex flex-col items-center justify-center text-center space-y-3">
          <AlertCircle size={40} className="text-amber-500" strokeWidth={1.5} />
          <p className="font-medium text-lg">{data}</p>
        </div>
      );
    }

    return (
      <div className="overflow-x-auto pb-4">
        <div className="prose prose-slate max-w-none prose-table:w-full prose-table:border-separate prose-table:border-spacing-0 prose-table:border prose-table:border-white/60 prose-table:rounded-[24px] prose-table:overflow-hidden prose-table:shadow-sm prose-th:bg-white/60 prose-th:text-[#1D1D1F] prose-th:font-semibold prose-th:p-4 prose-th:text-left prose-th:border-b prose-th:border-white/60 prose-td:p-4 prose-td:border-b prose-td:border-white/40 prose-tr:last:prose-td:border-0 hover:prose-tr:bg-white/30 transition-colors">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data}</ReactMarkdown>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {resultData.invoices.map((invoiceData, invoiceIdx) => {
        const isSubTotalCorrect = invoiceData.summary.billTotal === undefined || invoiceData.summary.calculatedTotal === invoiceData.summary.billTotal;
        const isFinalTotalCorrect = invoiceData.summary.finalBillTotal === undefined || invoiceData.summary.finalCalculatedTotal === invoiceData.summary.finalBillTotal;

        return (
          <div key={invoiceIdx} className="space-y-4 sm:space-y-6">
            {resultData!.invoices.length > 1 && (
              <h2 className="text-xl font-bold text-[#1D1D1F] px-2">Hóa đơn {invoiceIdx + 1}</h2>
            )}
            {/* Status Banner */}
            <div className={cn(
              "px-4 py-4 sm:px-6 sm:py-5 rounded-[20px] sm:rounded-[24px] flex items-center gap-3 font-black text-base sm:text-lg tracking-tight",
              invoiceData.isCorrect ? "bg-[#F4FBF7] text-[#1E8E3E]" : "bg-[#FEF2F2] text-[#B91C1C]"
            )}>
              {invoiceData.isCorrect ? <CheckCircle2 size={24} className="sm:w-7 sm:h-7" strokeWidth={2.5} /> : <AlertCircle size={24} className="sm:w-7 sm:h-7" strokeWidth={2.5} />}
              {invoiceData.isCorrect ? "HÓA ĐƠN CHÍNH XÁC" : "HÓA ĐƠN CÓ SAI SÓT"}
            </div>

            {/* Items List */}
            <div className="bg-white rounded-[24px] sm:rounded-[32px] shadow-sm border border-gray-100 overflow-hidden">
              <div className="divide-y divide-gray-100/80 px-2">
                {invoiceData.items.map((item, idx) => (
                  <div key={idx} className="p-4 sm:p-6 flex justify-between items-start gap-3 sm:gap-4 hover:bg-gray-50/50 transition-colors rounded-2xl my-1">
                    <div className="space-y-1 sm:space-y-1.5 min-w-0 flex-1">
                      {onChange ? (
                        <input
                          type="text"
                          value={item.name}
                          onChange={(e) => handleItemChange(invoiceIdx, idx, 'name', e.target.value)}
                          className="font-bold text-[#1D1D1F] text-[15px] sm:text-base leading-snug w-full bg-transparent border-b border-dashed border-gray-300 focus:border-rose-500 outline-none pb-0.5"
                          placeholder="Tên hàng hóa"
                        />
                      ) : (
                        <h3 className="font-bold text-[#1D1D1F] text-[15px] sm:text-base leading-snug break-words">{item.name}</h3>
                      )}
                      {onChange ? (
                        <div className="flex items-center gap-2 mt-1.5">
                          <input 
                            type="number" 
                            value={item.quantity} 
                            onChange={(e) => handleItemChange(invoiceIdx, idx, 'quantity', e.target.value)}
                            className="w-16 px-2 py-1 text-[13px] border border-gray-200 rounded-md focus:ring-1 focus:ring-rose-500 outline-none bg-gray-50/50"
                            min="0"
                            step="any"
                          />
                          <span className="text-[13px] text-[#86868B] font-medium">x</span>
                          <input 
                            type="number" 
                            value={item.unitPrice} 
                            onChange={(e) => handleItemChange(invoiceIdx, idx, 'unitPrice', e.target.value)}
                            className="w-24 px-2 py-1 text-[13px] border border-gray-200 rounded-md focus:ring-1 focus:ring-rose-500 outline-none bg-gray-50/50"
                            min="0"
                            step="any"
                          />
                        </div>
                      ) : (
                        <p className="text-[13px] text-[#86868B] font-medium">
                          {item.quantity} x {formatCurrency(item.unitPrice)}
                        </p>
                      )}
                      {!item.isCorrect && item.billTotal !== undefined && (
                        <p className="text-xs text-red-600 font-medium bg-red-50 inline-block px-2 py-1 rounded-md mt-1.5 border border-red-100">
                          Lệch: {formatCurrency(item.calculatedTotal - item.billTotal)}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0 flex flex-col items-end justify-start">
                      <span className={cn(
                        "font-bold text-base sm:text-lg tracking-tight leading-none",
                        item.isCorrect ? "text-[#1D1D1F]" : "text-red-600"
                      )}>
                        {formatCurrency(item.calculatedTotal)}
                      </span>
                      {!item.isCorrect && item.billTotal !== undefined && (
                        <span className="text-[11px] sm:text-xs text-[#86868B] line-through mt-1.5 font-medium">
                          {formatCurrency(item.billTotal)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Summary Section */}
              <div className="p-5 sm:p-8 space-y-4">
                <div className="h-px bg-gray-100 w-full mb-4 sm:mb-6" />
                {invoiceData.summary.billTotal !== undefined && (
                  <div className="flex justify-between items-center text-[14px] sm:text-[15px] font-medium text-[#86868B]">
                    <span>Cộng tiền hàng (ghi trên bill):</span>
                    <span className={!isSubTotalCorrect ? "line-through" : ""}>{formatCurrency(invoiceData.summary.billTotal)}</span>
                  </div>
                )}
                
                <div className="flex justify-between items-center">
                  <span className="text-lg sm:text-xl font-black text-[#0066CC] tracking-tight">Cộng tiền hàng (tính lại):</span>
                  <span className="text-2xl sm:text-3xl font-black text-[#0066CC] tracking-tight">
                    {formatCurrency(invoiceData.summary.calculatedTotal)}
                  </span>
                </div>

                {!isSubTotalCorrect && invoiceData.summary.billTotal !== undefined && (
                  <div className="flex justify-between items-center mt-2 p-3 bg-red-50 border border-red-100 rounded-xl">
                    <span className="text-sm font-bold text-red-700">Lệch tiền hàng:</span>
                    <span className="text-base font-bold text-red-700">
                      {formatCurrency(invoiceData.summary.calculatedTotal - invoiceData.summary.billTotal)}
                    </span>
                  </div>
                )}

                {invoiceData.summary.adjustments && invoiceData.summary.adjustments.length > 0 && (
                  <>
                    <div className="h-px bg-gray-100 w-full my-4 sm:my-6" />
                    {invoiceData.summary.adjustments.map((adj, idx) => (
                      <div key={idx} className={cn("flex justify-between items-center text-[14px] sm:text-[15px] font-medium mb-2", adj.type === 'add' ? "text-[#86868B]" : "text-[#34C759]")}>
                        <span>{adj.description || (adj.type === 'add' ? 'Cộng thêm' : 'Trừ đi')}:</span>
                        <span>{adj.type === 'add' ? '+' : '-'}{formatCurrency(adj.amount)}</span>
                      </div>
                    ))}
                    
                    <div className="h-px bg-gray-100 w-full my-4 sm:my-6" />
                    {invoiceData.summary.finalBillTotal !== undefined && (
                      <div className="flex justify-between items-center text-[14px] sm:text-[15px] font-medium text-[#86868B]">
                        <span>Tổng cộng cuối (ghi trên bill):</span>
                        <span className={!isFinalTotalCorrect ? "line-through" : ""}>{formatCurrency(invoiceData.summary.finalBillTotal)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center mt-1 sm:mt-2">
                      <span className="text-lg sm:text-xl font-black text-[#FF3B30] tracking-tight">Tổng cộng cuối (tính lại):</span>
                      <span className="text-2xl sm:text-3xl font-black text-[#FF3B30] tracking-tight">
                        {formatCurrency(invoiceData.summary.finalCalculatedTotal)}
                      </span>
                    </div>
                    {!isFinalTotalCorrect && invoiceData.summary.finalBillTotal !== undefined && (
                      <div className="flex justify-between items-center mt-2 p-3 bg-red-50 border border-red-100 rounded-xl">
                        <span className="text-sm font-bold text-red-700">Lệch tổng cuối:</span>
                        <span className="text-base font-bold text-red-700">
                          {formatCurrency(invoiceData.summary.finalCalculatedTotal - invoiceData.summary.finalBillTotal)}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

const processImagesWithGemini = async (imgs: string[], aiInstance: any, products: Product[] = []): Promise<string> => {
  const productListStr = products.length > 0 
    ? "\n\nDANH SÁCH SẢN PHẨM THAM KHẢO (Hãy ưu tiên nhận diện tên hàng theo danh sách này nếu khớp):\n" + 
      products.map(p => {
        let fullName = p.name || "Sản phẩm không tên";
        const parts: string[] = [];
        if (p.size) parts.push(p.size.replace(/\*/g, 'x'));
        if (p.thickness) parts.push(p.thickness);
        if (p.attributes) {
          Object.entries(p.attributes).forEach(([k, v]) => {
            if (v === 'Có') parts.push(k);
            else if (k.toUpperCase() === 'KÍCH THƯỚC' || k.toUpperCase() === 'DÀY' || k.toUpperCase() === 'SIZE') {
              parts.push(v.replace(/\*/g, 'x'));
            } else {
              parts.push(`${k}: ${v}`);
            }
          });
        }
        
        const uniqueParts = parts.filter(part => !fullName.toLowerCase().includes(part.toLowerCase()));
        const infoStr = uniqueParts.length > 0 ? ` ${uniqueParts.join(' - ')}` : "";
        
        return `- ${fullName}${infoStr} (Giá: ${p.price}${p.unit ? `/${p.unit}` : ''})`;
      }).join('\n')
    : "";

  const parts: any[] = [
    {
      text: `Hãy trích xuất chính xác các con số được viết trên hình ảnh hóa đơn này. Nếu có nhiều hình ảnh hóa đơn, hãy trích xuất riêng biệt từng hóa đơn vào mảng 'invoices'.
      YÊU CẦU QUAN TRỌNG:
      1. Bỏ qua thông tin cửa hàng, địa chỉ, số điện thoại.
      2. CHỈ TRÍCH XUẤT, KHÔNG TỰ TÍNH TOÁN LẠI. Nếu trên giấy viết sai toán học (ví dụ 20 x 85 = 1100), bạn BẮT BUỘC phải trích xuất đúng con số 1100 đã viết trên giấy vào trường 'amountWritten'. KHÔNG ĐƯỢC tự sửa thành 1700.
      3. Trích xuất các mặt hàng: Tên (BẮT BUỘC phải bao gồm kích thước, độ dày nếu có trên hóa đơn), Số lượng, Đơn giá, và Thành tiền (con số ghi ở cuối mỗi dòng).
      ${productListStr}
      4. Trích xuất phần Tổng cộng:
         - 'subTotalWritten': Tổng tiền hàng hóa (kết quả cộng các dòng hàng). CHÚ Ý: Đôi khi tổng tiền chỉ được ghi ở dòng cuối cùng với chữ "Nhận", "Cộng", "Tổng", "TC", hoặc chỉ là một con số nằm dưới đường gạch ngang. Hãy lấy con số đó làm subTotalWritten.
         - 'adjustments': Các dòng cộng/trừ thêm bên dưới tổng tiền hàng (ví dụ: + 12.160 nợ cũ, hoặc - 500 trả trước).
         - 'finalTotalWritten': Tổng cộng cuối cùng ghi trên giấy (sau khi đã cộng/trừ các khoản ở trên). Nếu không có khoản cộng/trừ nào, finalTotalWritten có thể bằng subTotalWritten.
      5. LƯU Ý CHỮ VIẾT TAY: Người viết thường thêm các nét gạch ngang, ký hiệu (như '- w', '- m', 'k', 'đ', 'cu', 'w') ở cuối các con số (ví dụ: '9.240 - w', '1.700 - m', '12.160 - w'). Hãy BỎ QUA các ký hiệu này, CHỈ lấy phần con số chính (ví dụ: 9240, 1700, 12160). 
      6. TUYỆT ĐỐI KHÔNG ghép/nối các con số ở các dòng khác nhau thành một số khổng lồ (ví dụ không được ghép 9240 và 1100 thành 92401100). Mỗi trường chỉ chứa 1 con số duy nhất tương ứng.
      7. NẾU MỘT SỐ BỊ NHÌN THẤY THÀNH 2 LẦN HOẶC BỊ BÓNG MỜ (ví dụ 1307000 1307000), CHỈ LẤY 1 SỐ DUY NHẤT (1307000). TUYỆT ĐỐI KHÔNG ĐƯỢC GHÉP CHÚNG LẠI THÀNH SỐ KHỔNG LỒ (ví dụ 13070001307000).
      8. Trả về JSON theo đúng schema.`,
    }
  ];

  for (const img of imgs) {
    const base64Data = img.split(',')[1];
    const mimeType = img.split(';')[0].split(':')[1];
    parts.push({
      inlineData: {
        mimeType: mimeType || "image/jpeg",
        data: base64Data,
      },
    });
  }
  
  const response = await aiInstance.models.generateContent({
    model: "gemini-3.1-flash-lite-preview",
    contents: [{ parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isInvoice: {
            type: Type.BOOLEAN,
            description: "Trả về true nếu hình ảnh là hóa đơn, biên lai, phiếu tính tiền. Trả về false nếu hình ảnh KHÔNG PHẢI là hóa đơn (ví dụ: ảnh phong cảnh, ảnh người, ảnh đồ vật không liên quan)."
          },
          invoices: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                items: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: "Tên mặt hàng" },
                      quantity: { type: Type.NUMBER, description: "Số lượng" },
                      unitPrice: { type: Type.NUMBER, description: "Đơn giá" },
                      amountWritten: { type: Type.NUMBER, description: "Thành tiền GHI TRÊN GIẤY của dòng này (KHÔNG TỰ TÍNH)" }
                    },
                    required: ["name", "quantity", "unitPrice"]
                  }
                },
                summary: {
                  type: Type.OBJECT,
                  properties: {
                    subTotalWritten: { type: Type.NUMBER, description: "Cộng tiền hàng GHI TRÊN GIẤY" },
                    adjustments: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          description: { type: Type.STRING, description: "Mô tả khoản cộng/trừ (vd: Nợ cũ, Ứng trước)" },
                          type: { type: Type.STRING, description: "'add' nếu là cộng thêm, 'subtract' nếu là trừ đi" },
                          amount: { type: Type.NUMBER, description: "Số tiền" }
                        },
                        required: ["type", "amount"]
                      }
                    },
                    finalTotalWritten: { type: Type.NUMBER, description: "Tổng cộng cuối cùng GHI TRÊN GIẤY" }
                  }
                }
              },
              required: ["items", "summary"]
            }
          }
        },
        required: ["isInvoice"]
      }
    }
  });

  const rawDataText = response.text || "{}";
  let analysisResult = "";
  
  try {
    const rawData = JSON.parse(rawDataText);
    
    if (rawData.isInvoice === false) {
      analysisResult = "Ui ui đây không phải hóa đơn Sếp ơi, Sếp uống mấy lon Bia rồi Sếp, nghỉ đi Sếp ơiiii ! ";
    } else {
      const rawInvoices = rawData.invoices || [];
      
      const processedInvoices: InvoiceData[] = rawInvoices.map((rawInvoice: any) => {
      const fixDuplicatedNumber = (num: number | undefined): number | undefined => {
        if (num === undefined) return undefined;
        const str = num.toString();
        if (str.length > 6 && str.length % 2 === 0) {
          const half1 = str.slice(0, str.length / 2);
          const half2 = str.slice(str.length / 2);
          if (half1 === half2) {
            return parseFloat(half1);
          }
        }
        return num;
      };

      const processedItems = (rawInvoice.items || []).map((item: any) => {
        const quantity = fixDuplicatedNumber(item.quantity) || 0;
        const unitPrice = fixDuplicatedNumber(item.unitPrice) || 0;
        const calculatedTotal = quantity * unitPrice;
        const amountWritten = fixDuplicatedNumber(item.amountWritten);
        const isItemCorrect = amountWritten === undefined || calculatedTotal === amountWritten;
        return {
          name: item.name || "Không rõ",
          quantity: quantity,
          unitPrice: unitPrice,
          calculatedTotal: calculatedTotal,
          billTotal: amountWritten,
          isCorrect: isItemCorrect
        };
      });

      const calculatedSubTotal = processedItems.reduce((sum: number, item: any) => sum + item.calculatedTotal, 0);

      const adjustments = rawInvoice.summary?.adjustments || [];
      let calculatedFinalTotal = calculatedSubTotal;
      const processedAdjustments = adjustments.map((adj: any) => ({
        ...adj,
        amount: fixDuplicatedNumber(adj.amount) || 0
      }));
      processedAdjustments.forEach((adj: any) => {
        if (adj.type === 'add') calculatedFinalTotal += adj.amount;
        else if (adj.type === 'subtract') calculatedFinalTotal -= adj.amount;
      });

      let subTotalWritten = fixDuplicatedNumber(rawInvoice.summary?.subTotalWritten);
      let finalTotalWritten = fixDuplicatedNumber(rawInvoice.summary?.finalTotalWritten);

      if (processedAdjustments.length === 0) {
        if ((subTotalWritten === undefined || subTotalWritten === 0) && finalTotalWritten !== undefined && finalTotalWritten > 0) {
          subTotalWritten = finalTotalWritten;
        } else if ((finalTotalWritten === undefined || finalTotalWritten === 0) && subTotalWritten !== undefined && subTotalWritten > 0) {
          finalTotalWritten = subTotalWritten;
        }
      }

      const isSubTotalCorrect = subTotalWritten === undefined || calculatedSubTotal === subTotalWritten;
      const isFinalTotalCorrect = finalTotalWritten === undefined || calculatedFinalTotal === finalTotalWritten;
      const isItemsCorrect = processedItems.every((item: any) => item.isCorrect);

      return {
        isCorrect: isItemsCorrect && isSubTotalCorrect && isFinalTotalCorrect,
        items: processedItems,
        summary: {
          billTotal: subTotalWritten,
          calculatedTotal: calculatedSubTotal,
          adjustments: processedAdjustments,
          finalCalculatedTotal: calculatedFinalTotal,
          finalBillTotal: finalTotalWritten
        }
      };
    });

    const invoiceResult: InvoiceResult = {
      invoices: processedInvoices
    };

    analysisResult = JSON.stringify(invoiceResult, null, 2);
    }
  } catch (e) {
    console.error("Failed to process raw data", e);
    analysisResult = rawDataText;
  }

  return analysisResult;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [images, setImages] = useState<string[]>(() => {
    const saved = localStorage.getItem('current_images');
    try {
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<string | null>(() => localStorage.getItem('current_result'));
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(() => localStorage.getItem('current_history_id'));
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showProducts, setShowProducts] = useState(false);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [showDeleteAllHistoryConfirm, setShowDeleteAllHistoryConfirm] = useState(false);
  const [isDeletingAllHistory, setIsDeletingAllHistory] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [hasAIStudioKey, setHasAIStudioKey] = useState<boolean | null>(null);
  const [serverKey, setServerKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [showBulkUpload, setShowBulkUpload] = useState(false);
  const [showChatbotKnowledge, setShowChatbotKnowledge] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [minPrice, setMinPrice] = useState<number | null>(null);
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'price-asc' | 'price-desc' | 'newest'>('name');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showLuckyMessage, setShowLuckyMessage] = useState(false);
  const [luckyMessageText, setLuckyMessageText] = useState("🧧 Cung Hỷ Phát Tài 🧧");
  const luckyClickCountRef = useRef(0);
  const luckyTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handleLuckyCatClick = () => {
    luckyClickCountRef.current += 1;
    
    if (luckyTimerRef.current) {
      clearTimeout(luckyTimerRef.current);
    }

    if (luckyClickCountRef.current >= 3) {
      setLuckyMessageText("✨ Sếp Huy đẹp trai Phát Tài Phát Lộc ✨");
    } else {
      setLuckyMessageText("🧧 Cung Hỷ Phát Tài 🧧");
    }

    setShowLuckyMessage(true);
    
    luckyTimerRef.current = setTimeout(() => {
      setShowLuckyMessage(false);
      luckyClickCountRef.current = 0;
    }, 3000);
  };

  const guessCategory = (name: string): string => {
    const n = name.toLowerCase();
    if (n.includes('nệm') || n.includes('đệm')) return 'Nệm';
    if (n.includes('gối')) return 'Gối';
    if (n.includes('drap') || n.includes('ga') || n.includes('mền') || n.includes('chăn')) return 'Chăn Ga';
    if (n.includes('chiếu')) return 'Chiếu';
    if (n.includes('topper')) return 'Topper';
    if (n.includes('tấm bảo vệ')) return 'Bảo vệ nệm';
    if (n.includes('võng')) return 'Võng';
    if (n.includes('mùng') || n.includes('màn')) return 'Mùng/Màn';
    if (n.includes('giường')) return 'Giường';
    if (n.includes('tủ')) return 'Tủ';
    if (n.includes('bàn') || n.includes('ghế')) return 'Bàn Ghế';
    return 'Khác';
  };

  const getCategoryColor = (cat: string | null): string => {
    if (!cat) return "blue";
    const c = cat.toLowerCase();
    if (c.includes('nệm') || c.includes('đệm')) return "blue";
    if (c.includes('gối')) return "green";
    if (c.includes('chăn ga') || c.includes('drap') || c.includes('mền')) return "purple";
    if (c.includes('chiếu')) return "orange";
    if (c.includes('topper')) return "pink";
    if (c.includes('bảo vệ')) return "cyan";
    if (c.includes('võng')) return "teal";
    if (c.includes('mùng') || c.includes('màn')) return "indigo";
    if (c.includes('giường')) return "amber";
    if (c.includes('tủ')) return "slate";
    if (c.includes('bàn') || c.includes('ghế')) return "rose";
    return "gray";
  };

  const categories = useMemo(() => {
    const cats = new Set<string>();
    products.forEach(p => {
      const cat = p.category || guessCategory(p.name);
      if (cat) cats.add(cat);
    });
    return Array.from(cats).sort();
  }, [products]);

  const filteredProducts = useMemo(() => {
    try {
      let result = [...products];
      
      // Category filter
      if (selectedCategory) {
        result = result.filter(p => (p.category || guessCategory(p.name)) === selectedCategory);
      }
      
      // Price range filter
      if (minPrice !== null) {
        result = result.filter(p => (p.price || 0) >= minPrice);
      }
      if (maxPrice !== null) {
        result = result.filter(p => (p.price || 0) <= maxPrice);
      }
      
      // Search query filter
      if (searchQuery) {
        const terms = searchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (terms.length > 0) {
          result = result.filter(p => {
            if (!p) return false;
            return terms.every(term => {
              const termAlt = term.replace(/x/g, '*');
              const termAlt2 = term.replace(/\*/g, 'x');
              
              const nameMatch = p.name ? (String(p.name).toLowerCase().includes(term) || String(p.name).toLowerCase().includes(termAlt) || String(p.name).toLowerCase().includes(termAlt2)) : false;
              const sizeMatch = p.size ? (String(p.size).toLowerCase().includes(term) || String(p.size).toLowerCase().includes(termAlt) || String(p.size).toLowerCase().includes(termAlt2)) : false;
              const thicknessMatch = p.thickness ? (String(p.thickness).toLowerCase().includes(term) || String(p.thickness).toLowerCase().includes(termAlt) || String(p.thickness).toLowerCase().includes(termAlt2)) : false;
              const descriptionMatch = p.description ? String(p.description).toLowerCase().includes(term) : false;
              const categoryMatch = p.category ? String(p.category).toLowerCase().includes(term) : false;
              const unitMatch = p.unit ? String(p.unit).toLowerCase().includes(term) : false;
              
              const priceValue = p.price !== undefined && p.price !== null ? p.price : 0;
              const priceMatch = String(priceValue).includes(term) || formatCurrency(Number(priceValue)).includes(term);
              
              const wholesaleValue = p.wholesalePrice !== undefined && p.wholesalePrice !== null ? p.wholesalePrice : null;
              const wholesaleMatch = wholesaleValue !== null ? (String(wholesaleValue).includes(term) || formatCurrency(Number(wholesaleValue)).includes(term)) : false;
              
              const attrMatch = p.attributes && Object.entries(p.attributes).some(([key, val]) => {
                if (!key) return false;
                const k = String(key).toLowerCase();
                const v = val ? String(val).toLowerCase() : '';
                return k.includes(term) || v.includes(term) || v.includes(termAlt) || v.includes(termAlt2);
              });
              
              return nameMatch || sizeMatch || thicknessMatch || descriptionMatch || categoryMatch || attrMatch || unitMatch || priceMatch || wholesaleMatch;
            });
          });
        }
      }
      
      // Sorting
      result.sort((a, b) => {
        switch (sortBy) {
          case 'price-asc':
            return (a.price || 0) - (b.price || 0);
          case 'price-desc':
            return (b.price || 0) - (a.price || 0);
          case 'newest':
            return (b.createdAt || 0) - (a.createdAt || 0);
          case 'name':
          default:
            return (a.name || '').localeCompare(b.name || '');
        }
      });
      
      return result;
    } catch (err) {
      console.error("Search error:", err);
      return [];
    }
  }, [products, searchQuery, selectedCategory, minPrice, maxPrice, sortBy]);

  const groupedProducts = useMemo(() => {
    const groups: Record<string, Product[]> = {};
    filteredProducts.forEach(p => {
      if (!groups[p.name]) groups[p.name] = [];
      groups[p.name].push(p);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredProducts]);

  // Chatbot state
  const [chatbotKnowledge, setChatbotKnowledge] = useState<string>('');
  const [isSavingKnowledge, setIsSavingKnowledge] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(() => localStorage.getItem('chat_open') === 'true');
  const [chatMessages, setChatMessages] = useState<{role: 'user'|'model', text: string}[]>(() => {
    const saved = localStorage.getItem('chat_messages');
    try {
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });
  const [chatInput, setChatInput] = useState(() => localStorage.getItem('chat_input') || '');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatSessionRef = useRef<any>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Version check for auto-update
  useEffect(() => {
    const checkVersion = async () => {
      try {
        const response = await fetch('/api/version');
        if (!response.ok) return;
        const data = await response.json();
        const storedVersion = localStorage.getItem('app_version');
        
        if (data.version && storedVersion && data.version !== storedVersion) {
          console.log(`New version detected: ${data.version}. Updating...`);
          localStorage.setItem('app_version', data.version);
          window.location.reload();
        } else if (data.version && !storedVersion) {
          localStorage.setItem('app_version', data.version);
        }
      } catch (e) {
        // Silent fail
      }
    };
    checkVersion();
    // Check every 15 minutes
    const interval = setInterval(checkVersion, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Persist chatbot state
  useEffect(() => {
    localStorage.setItem('chat_open', String(isChatOpen));
  }, [isChatOpen]);

  useEffect(() => {
    localStorage.setItem('chat_messages', JSON.stringify(chatMessages));
  }, [chatMessages]);

  useEffect(() => {
    localStorage.setItem('chat_input', chatInput);
  }, [chatInput]);

  const isAdmin = user?.email === 'qhuy0301@gmail.com';

  // Refresh app on visibility change
  const isExternalActionRef = useRef(false);
  const lastHiddenTimeRef = useRef<number | null>(null);
  const triggerExternalAction = useCallback(() => {
    isExternalActionRef.current = true;
    setTimeout(() => {
      if (document.visibilityState === 'visible') {
        isExternalActionRef.current = false;
      }
    }, 1000);
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenTimeRef.current = Date.now();
      } else if (document.visibilityState === 'visible') {
        if (isExternalActionRef.current) {
          isExternalActionRef.current = false;
        } else if (lastHiddenTimeRef.current && Date.now() - lastHiddenTimeRef.current > 3600000) {
          // Only reload if the app has been hidden for more than 1 hour (3600000 ms)
          window.location.reload();
        }
        lastHiddenTimeRef.current = null;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // iOS Install Guide logic
  useEffect(() => {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone;
    
    if (isIOS && !isStandalone) {
      const hasSeenGuide = localStorage.getItem('has_seen_install_guide');
      if (!hasSeenGuide) {
        setShowInstallGuide(true);
        localStorage.setItem('has_seen_install_guide', 'true');
      }
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(collection(db, 'chatbot_knowledge'), limit(1));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        setChatbotKnowledge(snapshot.docs[0].data().content || '');
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'chatbot_knowledge');
    });
    return () => unsubscribe();
  }, [user]);

  const handleSaveKnowledge = async () => {
    if (!user || !isAdmin) return;
    setIsSavingKnowledge(true);
    try {
      const q = query(collection(db, 'chatbot_knowledge'), limit(1));
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        await updateDoc(doc(db, 'chatbot_knowledge', snapshot.docs[0].id), {
          content: chatbotKnowledge,
          updatedAt: serverTimestamp()
        });
      } else {
        await addDoc(collection(db, 'chatbot_knowledge'), {
          content: chatbotKnowledge,
          uid: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }
      // Feedback is handled by button state/content
    } catch (err) {
      console.error("Save knowledge error:", err);
      handleFirestoreError(err, OperationType.UPDATE, 'chatbot_knowledge');
    } finally {
      setIsSavingKnowledge(false);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsChatLoading(true);

    try {
      const aiInstance = getAI(manualKey, serverKey);
      if (!aiInstance) {
        setChatMessages(prev => [...prev, { role: 'model', text: "Vui lòng cấu hình API Key trước khi sử dụng Chatbot." }]);
        setIsChatLoading(false);
        return;
      }

      if (!chatSessionRef.current) {
        let productListStr = "";
        if (products.length > 0) {
          productListStr = "\n\nDưới đây là danh sách sản phẩm và giá hiện tại của cửa hàng:\n" + 
            products.map(p => {
              let fullName = p.name || "Sản phẩm không tên";
              const parts: string[] = [];
              if (p.size) parts.push(p.size.replace(/\*/g, 'x'));
              if (p.thickness) parts.push(p.thickness);
              if (p.attributes) {
                Object.entries(p.attributes).forEach(([k, v]) => {
                  if (v === 'Có') parts.push(k);
                  else if (k.toUpperCase() === 'KÍCH THƯỚC' || k.toUpperCase() === 'DÀY' || k.toUpperCase() === 'SIZE') {
                    parts.push(v.replace(/\*/g, 'x'));
                  } else {
                    parts.push(`${k}: ${v}`);
                  }
                });
              }
              
              const uniqueParts = parts.filter(part => !fullName.toLowerCase().includes(part.toLowerCase()));
              const infoStr = uniqueParts.length > 0 ? ` ${uniqueParts.join(' - ')}` : "";
              
              const unitStr = p.unit && !fullName.toLowerCase().includes(`(${p.unit})`) ? `/${p.unit}` : '';
              const wholesaleStr = isAdmin && p.wholesalePrice ? `, Giá sỉ: ${formatCurrency(p.wholesalePrice)}` : '';
              const descStr = p.description ? ` (${p.description})` : '';
              return `- ${fullName}${infoStr}: Giá bán chung: ${formatCurrency(p.price)}${unitStr}${wholesaleStr}${descStr}`;
            }).join('\n') +
            "\n\nHãy sử dụng bảng giá này để báo giá chính xác cho khách hàng khi được hỏi. Lưu ý: Khi khách hàng hỏi giá, CHỈ báo Giá bán chung.";
        }

        chatSessionRef.current = aiInstance.chats.create({
          model: "gemini-3.1-flash-lite-preview",
          config: {
            systemInstruction: "Bạn là trợ lý ảo của cửa hàng nệm Mận Quý (Mận Quý Mattress Store). Bạn giúp khách hàng giải đáp thắc mắc về sản phẩm, hóa đơn, và các vấn đề liên quan đến cửa hàng. Hãy trả lời ngắn gọn, lịch sự và thân thiện bằng tiếng Việt. Khi khách hàng cần liên hệ trực tiếp hoặc hỏi thông tin liên lạc, hãy cung cấp số điện thoại cửa hàng là 0918030188 và người tư vấn là anh Huy. Đặc biệt lưu ý: Khi có ai hỏi về tên Ngân, hãy trả lời đó là Ngân Khùng. Quy tắc về kích thước: 100 tương đương 1m, 120 tương đương 1m2, 140 tương đương 1m4, 160 tương đương 1m6, 180 tương đương 1m8, 200 tương đương 2m, 220 tương đương 2m2. Hãy hiểu các con số này khi khách hàng hỏi về kích thước nệm." + 
            (chatbotKnowledge ? `\n\nThông tin bổ sung từ cửa hàng:\n${chatbotKnowledge}` : "") +
            productListStr,
          }
        });
      }

      const response = await chatSessionRef.current.sendMessageStream({ message: userMessage });
      
      setChatMessages(prev => [...prev, { role: 'model', text: '' }]);
      
      let fullText = '';
      for await (const chunk of response) {
        fullText += (chunk as any).text;
        setChatMessages(prev => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1].text = fullText;
          return newMessages;
        });
      }
    } catch (error) {
      console.error("Chat error:", error);
      setChatMessages(prev => [...prev, { role: 'model', text: "Xin lỗi, đã có lỗi xảy ra khi kết nối với AI. Vui lòng thử lại sau." }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const clearChat = () => {
    setChatMessages([]);
    localStorage.removeItem('chat_messages');
    chatSessionRef.current = null;
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/app-config');
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        const data = await res.json();
        if (data.apiKey) {
          setServerKey(data.apiKey);
          setHasAIStudioKey(true);
        } else {
          // Fallback to AI Studio window API if server doesn't have it
          if (window.aistudio) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            setHasAIStudioKey(hasKey);
          } else {
            setHasAIStudioKey(false);
          }
        }
      } catch (e) {
        // Silently fallback to AI Studio window API if server fetch fails
        // This is expected when running as a static site (e.g., Vercel)
        if (window.aistudio) {
          try {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            setHasAIStudioKey(hasKey);
          } catch (err) {
            setHasAIStudioKey(false);
          }
        } else {
          setHasAIStudioKey(false);
        }
      }
    };
    fetchConfig();
  }, []);

  const handleOpenAIStudioKey = async () => {
    if (window.aistudio) {
      try {
        await window.aistudio.openSelectKey();
        setHasAIStudioKey(true);
      } catch (e) {
        console.error("Error opening AI Studio key dialog:", e);
      }
    }
  };
  const [showHistory, setShowHistory] = useState(false);
  const [zoomedImageIndex, setZoomedImageIndex] = useState<number | null>(null);
  const [manualKey, setManualKey] = useState<string>(() => localStorage.getItem('manquy_api_key') || '');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);

  // Error handling helper
  const handleFirestoreError = (error: unknown, operationType: OperationType, path: string | null) => {
    const errInfo: FirestoreErrorInfo = {
      error: error instanceof Error ? error.message : String(error),
      authInfo: {
        userId: auth.currentUser?.uid,
        email: auth.currentUser?.email,
        emailVerified: auth.currentUser?.emailVerified,
      },
      operationType,
      path
    };
    console.error('Firestore Error: ', JSON.stringify(errInfo));
    setError(`Lỗi cơ sở dữ liệu: ${errInfo.error}`);
  };

  const [isUploading, setIsUploading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  // Scroll lock for overlays
  useEffect(() => {
    if (showHistory || zoomedImageIndex !== null || showSettings) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [showHistory, zoomedImageIndex, showSettings]);

  // Persist current state to localStorage
  useEffect(() => {
    localStorage.setItem('current_images', JSON.stringify(images));
  }, [images]);

  useEffect(() => {
    if (result) localStorage.setItem('current_result', result);
    else localStorage.removeItem('current_result');
  }, [result]);

  useEffect(() => {
    if (currentHistoryId) localStorage.setItem('current_history_id', currentHistoryId);
    else localStorage.removeItem('current_history_id');
  }, [currentHistoryId]);

  // Auto-save result changes to Firestore
  useEffect(() => {
    if (!user || !currentHistoryId || !result) return;
    
    const timeoutId = setTimeout(async () => {
      try {
        await updateDoc(doc(db, 'history', currentHistoryId), { result });
      } catch (err) {
        console.error("Auto-save error:", err);
      }
    }, 1000);

    return () => clearTimeout(timeoutId);
  }, [result, user, currentHistoryId]);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Test connection to Firestore
  useEffect(() => {
    if (isAuthReady && user) {
      const testConnection = async () => {
        try {
          await getDocFromServer(doc(db, 'test', 'connection'));
        } catch (error) {
          if (error instanceof Error && error.message.includes('the client is offline')) {
            console.error("Please check your Firebase configuration.");
            setError("Không thể kết nối với cơ sở dữ liệu. Vui lòng kiểm tra cấu hình.");
          }
        }
      };
      testConnection();
    }
  }, [isAuthReady, user]);

  // Load history from Firestore
  useEffect(() => {
    if (!isAuthReady || !user) {
      setHistory([]);
      return;
    }

    console.log("Starting history load for user:", user.uid);
    const q = query(
      collection(db, 'history'),
      where('uid', '==', user.uid),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      console.log("History snapshot received, size:", snapshot.size);
      const items: HistoryItem[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp
        } as HistoryItem);
      });
      setHistory(items);
    }, (error) => {
      console.error("History snapshot error:", error);
      handleFirestoreError(error, OperationType.LIST, 'history');
    });

    return () => unsubscribe();
  }, [isAuthReady, user]);

  // Load products from Firestore
  useEffect(() => {
    // Fetch all products so the chatbot has access to them, regardless of login status
    const q = query(
      collection(db, 'products'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const items: Product[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt
        } as Product);
      });
      setProducts(items);
    }, (error) => {
      console.error("Products snapshot error:", error);
      // Only throw error if it's not a permission error when not logged in, though public read is now allowed
      if (user) {
        handleFirestoreError(error, OperationType.LIST, 'products');
      }
    });

    return () => unsubscribe();
  }, [user]);

  const handleDeleteProduct = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'products', id));
    } catch (err) {
      console.error("Delete product error:", err);
      handleFirestoreError(err, OperationType.DELETE, 'products');
    }
  };

  const handleDeleteHistory = async (id: string) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'history', id));
      if (currentHistoryId === id) {
        setResult(null);
        setImages([]);
        setCurrentHistoryId(null);
        localStorage.removeItem('current_result');
        localStorage.removeItem('current_images');
        localStorage.removeItem('current_history_id');
      }
    } catch (err) {
      console.error("Delete history error:", err);
      handleFirestoreError(err, OperationType.DELETE, 'history');
    }
  };

  const handleDeleteAllHistory = async () => {
    if (!user) return;
    
    setIsDeletingAllHistory(true);
    try {
      // Delete one by one for simplicity and safety
      for (const item of history) {
        await deleteDoc(doc(db, 'history', item.id));
      }
      setResult(null);
      setImages([]);
      setCurrentHistoryId(null);
      localStorage.removeItem('current_result');
      localStorage.removeItem('current_images');
      localStorage.removeItem('current_history_id');
      setShowDeleteAllHistoryConfirm(false);
    } catch (err) {
      console.error("Delete all history error:", err);
      handleFirestoreError(err, OperationType.DELETE, 'history');
    } finally {
      setIsDeletingAllHistory(false);
    }
  };

  const handleUpdateProduct = async (id: string, data: Partial<Product>) => {
    if (!user || !isAdmin) return;
    try {
      await updateDoc(doc(db, 'products', id), {
        ...data,
        updatedAt: serverTimestamp()
      });
      setEditingProduct(null);
    } catch (err) {
      console.error("Update product error:", err);
      handleFirestoreError(err, OperationType.UPDATE, 'products');
    }
  };

  const handleDeleteAllProducts = async () => {
    if (!user || !isAdmin) return;
    
    setIsSavingProduct(true);
    try {
      // For simplicity and safety in this environment, we delete one by one
      for (const product of products) {
        await deleteDoc(doc(db, 'products', product.id));
      }
      setShowDeleteAllConfirm(false);
    } catch (err) {
      console.error("Delete all products error:", err);
      handleFirestoreError(err, OperationType.DELETE, 'products');
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleExcelUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsSavingProduct(true);
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(worksheet);

      let addedCount = 0;
      for (const row of json as any[]) {
        const normalizedRow: Record<string, any> = {};
        for (const key in row) {
          normalizedRow[key.toLowerCase().trim()] = row[key];
        }

        const name = normalizedRow['tên sản phẩm'] || normalizedRow['tên'] || normalizedRow['name'] || normalizedRow['sản phẩm'] || normalizedRow['product'] || normalizedRow['tên hàng'];
        const priceRaw = normalizedRow['giá bán chung'] || normalizedRow['giá'] || normalizedRow['giá tiền'] || normalizedRow['price'] || normalizedRow['đơn giá'] || normalizedRow['giá bán'];
        const wholesalePriceRaw = normalizedRow['giá sỉ'];
        const sizeRaw = normalizedRow['kích thước'] || normalizedRow['size'] || normalizedRow['kích cỡ'];
        const thicknessRaw = normalizedRow['độ dày'] || normalizedRow['thickness'];
        const unitRaw = normalizedRow['đơn vị tính'] || normalizedRow['đơn vị'] || normalizedRow['unit'] || normalizedRow['dvt'];
        const categoryRaw = normalizedRow['danh mục'] || normalizedRow['loại'] || normalizedRow['category'] || normalizedRow['nhóm'];
        const attributesRaw = normalizedRow['thuộc tính'] || normalizedRow['attributes'];
        const description = normalizedRow['mô tả'] || normalizedRow['description'] || normalizedRow['ghi chú'] || '';

        const trimmedName = name ? String(name).trim().substring(0, 190) : '';

        if (trimmedName && priceRaw !== undefined) {
          const priceStr = String(priceRaw).replace(/[^0-9]/g, '');
          const price = parseInt(priceStr, 10);
          
          let wholesalePrice = null;
          if (wholesalePriceRaw !== undefined) {
            const wholesalePriceStr = String(wholesalePriceRaw).replace(/[^0-9]/g, '');
            const parsedWholesalePrice = parseInt(wholesalePriceStr, 10);
            if (!isNaN(parsedWholesalePrice)) {
              wholesalePrice = parsedWholesalePrice;
            }
          }

          if (!isNaN(price)) {
            let fullName = trimmedName;
            const size = sizeRaw !== undefined && sizeRaw !== null && sizeRaw !== '' ? String(sizeRaw).trim().substring(0, 90) : '';
            const thickness = thicknessRaw !== undefined && thicknessRaw !== null && thicknessRaw !== '' ? String(thicknessRaw).trim().substring(0, 90) : '';
            
            // Ensure name includes size and thickness if they are not already there
            if (size && !fullName.toLowerCase().includes(size.toLowerCase())) {
              fullName += ` ${size}`;
            }
            if (thickness && !fullName.toLowerCase().includes(thickness.toLowerCase())) {
              fullName += ` ${thickness}`;
            }

            const productData: any = {
              uid: user.uid,
              name: fullName,
              price: price,
              category: categoryRaw ? String(categoryRaw).trim() : guessCategory(fullName),
              description: String(description).trim().substring(0, 990),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            };
            
            if (wholesalePrice !== null) {
              productData.wholesalePrice = wholesalePrice;
            }
            if (size) {
              productData.size = size;
            }
            if (thickness) {
              productData.thickness = thickness;
            }
            if (unitRaw !== undefined && unitRaw !== null && unitRaw !== '') {
              productData.unit = String(unitRaw).trim().substring(0, 45);
            }

            // Parse dynamic attributes
            if (attributesRaw) {
              const attrStr = String(attributesRaw);
              const attrs: Record<string, string> = {};
              // Try to split by semicolon, comma, newline, or pipe
              const pairs = attrStr.split(/[;,\n|]/);
              pairs.forEach(p => {
                const [key, val] = p.split(':').map(s => s.trim());
                if (key && val) {
                  attrs[key] = val;
                } else if (key) {
                  // If no colon, just treat as a tag or generic attribute
                  attrs[key] = 'Có';
                }
              });
              if (Object.keys(attrs).length > 0) {
                productData.attributes = attrs;
              }
            }

            await addDoc(collection(db, 'products'), productData);
            addedCount++;
          }
        }
      }

      if (addedCount > 0) {
        alert(`Đã thêm thành công ${addedCount} sản phẩm từ file Excel!`);
      } else {
        alert('Không tìm thấy dữ liệu hợp lệ trong file Excel. Đảm bảo file có các cột: "Tên sản phẩm", "Giá Bán Chung", "Kích Thước", "Độ Dày".');
      }
    } catch (err) {
      console.error("Lỗi đọc file Excel:", err);
      handleFirestoreError(err, OperationType.CREATE, 'products');
      alert('Có lỗi xảy ra khi đọc file Excel.');
    } finally {
      setIsSavingProduct(false);
      if (excelInputRef.current) {
        excelInputRef.current.value = '';
      }
    }
  };

  const login = async () => {
    try {
      const provider = new GoogleAuthProvider();
      triggerExternalAction();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error("Login error:", err);
      if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
        // Ignore benign errors when the user closes the popup or a request is cancelled
        return;
      }
      if (err.code === 'auth/api-key-not-valid' || err.message?.includes('api-key-not-valid')) {
        setError("Cấu hình Firebase chưa hợp lệ (API Key không đúng). Vui lòng gửi cấu hình Firebase của bạn cho AI để thiết lập lại tính năng đăng nhập và lưu lịch sử.");
        return;
      }
      if (err.code === 'auth/unauthorized-domain') {
        setError("Tên miền này chưa được cấp quyền trong Firebase. Sếp vui lòng thêm tên miền của ứng dụng vào danh sách 'Authorized domains' trong Firebase Console nhé!");
        return;
      }
      if (err.code === 'auth/network-request-failed') {
        setError("Lỗi kết nối mạng (auth/network-request-failed). Sếp vui lòng kiểm tra: 1. Kết nối internet; 2. Tắt các trình chặn quảng cáo (AdBlock); 3. Thêm tên miền này vào 'Authorized domains' trong Firebase Console.");
        return;
      }
      if (err.code === 'auth/popup-blocked') {
        setError("Trình duyệt đã chặn cửa sổ đăng nhập. Vui lòng cho phép mở cửa sổ bật lên (pop-up) trên trang này và thử lại.");
        return;
      }
      setError(`Không thể đăng nhập (${err.code || err.message || 'Lỗi không xác định'}). Vui lòng thử lại hoặc kiểm tra cài đặt trình duyệt.`);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      reset();
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // Compress image helper
  const compressImage = (file: File | string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = typeof file === 'string' ? file : URL.createObjectURL(file);
      
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1024;
        const MAX_HEIGHT = 1024;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Không thể tạo bộ xử lý ảnh (Canvas context)"));
          return;
        }

        // 1. Apply dynamic preprocessing: Brightness & Contrast
        // This helps make the text stand out from the background, especially for low-quality scans.
        ctx.filter = 'contrast(1.2) brightness(1.1)';
        ctx.drawImage(img, 0, 0, width, height);

        // 2. Apply Sharpening Filter (Convolution Matrix)
        // This enhances edges, making text clearer for OCR.
        try {
          const imageData = ctx.getImageData(0, 0, width, height);
          const data = imageData.data;
          const src = new Uint8ClampedArray(data);
          const w = width;
          const h = height;
          
          for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
              const off = (y * w + x) * 4;
              const up = ((y - 1) * w + x) * 4;
              const down = ((y + 1) * w + x) * 4;
              const left = (y * w + (x - 1)) * 4;
              const right = (y * w + (x + 1)) * 4;
              
              data[off] = src[off] * 5 - src[up] - src[down] - src[left] - src[right];
              data[off + 1] = src[off + 1] * 5 - src[up + 1] - src[down + 1] - src[left + 1] - src[right + 1];
              data[off + 2] = src[off + 2] * 5 - src[up + 2] - src[down + 2] - src[left + 2] - src[right + 2];
            }
          }
          ctx.putImageData(imageData, 0, 0);
        } catch (e) {
          console.warn("Could not apply sharpening filter:", e);
        }
        
        // Cleanup object URL
        if (typeof file !== 'string') URL.revokeObjectURL(url);
        
        // Compress to JPEG with 0.6 quality to stay well under 1MB
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      };

      img.onerror = () => {
        if (typeof file !== 'string') URL.revokeObjectURL(url);
        reject(new Error("Không thể tải ảnh. Vui lòng kiểm tra định dạng tệp."));
      };

      img.src = url;
    });
  };

  // Handle File Upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const newImages: string[] = [];
      setError(null);
      
      for (let i = 0; i < files.length; i++) {
        try {
          const file = files[i];
          const compressed = await compressImage(file);
          newImages.push(compressed);
        } catch (err) {
          console.error("File processing error:", err);
          setError(`Lỗi xử lý tệp ${i + 1}: ${err instanceof Error ? err.message : "Không xác định"}`);
        }
      }
      
      if (newImages.length > 0) {
        setImages(newImages);
        setResult(null);
      }
    }
  };

  // Auto-resume processing on mount
  useEffect(() => {
    if (isAuthReady && user && history.length > 0) {
      const pendingItem = history.find(item => item.status === 'processing');
      if (pendingItem && !isAnalyzing) {
        console.log("Resuming pending analysis:", pendingItem.id);
        resumeAnalysis(pendingItem);
      }
    }
  }, [isAuthReady, user, history, isAnalyzing]);

  const resumeAnalysis = async (item: HistoryItem) => {
    if (!item.images || item.images.length === 0) return;
    
    setImages(item.images);
    setCurrentHistoryId(item.id);
    setIsAnalyzing(true);
    
    // Call the actual analysis logic but update existing doc
    await performAnalysis(item.images, item.id);
  };

  // Background recalculation of failed invoices
  const retriedFailedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user || !isAuthReady || !hasAIStudioKey) return;

    const failedItems = history.filter(item => item.status === 'failed' && !retriedFailedIds.current.has(item.id));
    
    if (failedItems.length === 0) return;

    const processFailedInBackground = async () => {
      const aiInstance = getAI(manualKey, serverKey);
      if (!aiInstance) return;

      for (const item of failedItems) {
        retriedFailedIds.current.add(item.id);
        
        try {
          // Mark as processing
          await updateDoc(doc(db, 'history', item.id), { status: 'processing' });

          const imgs = item.images || (item.image ? [item.image] : []);
          if (imgs.length === 0) {
            await updateDoc(doc(db, 'history', item.id), { status: 'failed' });
            continue;
          }

          const analysisResult = await processImagesWithGemini(imgs, aiInstance, products);

          await updateDoc(doc(db, 'history', item.id), {
            result: analysisResult,
            status: 'completed',
            timestamp: serverTimestamp(),
          });

        } catch (err) {
          console.error(`Background retry failed for ${item.id}:`, err);
          await updateDoc(doc(db, 'history', item.id), { status: 'failed' }).catch(() => {});
        }
      }
    };

    processFailedInBackground();
  }, [history, user, isAuthReady, hasAIStudioKey, manualKey, serverKey, products]);

  const analyzeImage = async () => {
    if (images.length === 0) return;
    
    const aiInstance = getAI(manualKey, serverKey);
    if (!aiInstance) {
      setError("Vui lòng chọn API Key (nút màu vàng ở trên) hoặc nhập Key trong phần Cài đặt.");
      return;
    }

    setIsAnalyzing(true);
    setIsUploading(true);
    setError(null);

    let docId = currentHistoryId;

    // 1. Create/Update Firestore doc with 'processing' status immediately
    if (user) {
      try {
        if (docId) {
          await updateDoc(doc(db, 'history', docId), {
            status: 'processing',
            timestamp: serverTimestamp()
          });
        } else {
          const docRef = await addDoc(collection(db, 'history'), {
            uid: user.uid,
            images: images,
            result: '',
            status: 'processing',
            timestamp: serverTimestamp(),
          });
          docId = docRef.id;
          setCurrentHistoryId(docId);
        }
        
        // Show upload success
        setIsUploading(false);
        setUploadSuccess(true);
        setTimeout(() => setUploadSuccess(false), 3000);
        
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, 'history');
        setIsAnalyzing(false);
        setIsUploading(false);
        return;
      }
    } else {
      setIsUploading(false);
    }

    await performAnalysis(images, docId);
  };

  const performAnalysis = async (imgs: string[], docId: string | null) => {
    const aiInstance = getAI(manualKey, serverKey);
    if (!aiInstance) return;

    try {
      const analysisResult = await processImagesWithGemini(imgs, aiInstance, products);

      setResult(analysisResult);

      // Update Firestore with result and 'completed' status
      if (user && docId) {
        try {
          await updateDoc(doc(db, 'history', docId), {
            result: analysisResult,
            status: 'completed',
            timestamp: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `history/${docId}`);
        }
      }

    } catch (err) {
      console.error("Analysis error:", err);
      const errorMessage = err instanceof Error ? err.message : "Không xác định";
      
      // Update Firestore with 'failed' status if possible
      if (user && docId) {
        updateDoc(doc(db, 'history', docId), { status: 'failed' }).catch(() => {});
      }

      if (errorMessage.includes("API key")) {
        setError("Lỗi API Key: Vui lòng kiểm tra lại cấu hình trong AI Studio.");
      } else if (errorMessage.includes("quota") || errorMessage.includes("spending cap") || errorMessage.includes("RESOURCE_EXHAUSTED") || errorMessage.includes("429")) {
        setError("Hết hạn mức sử dụng API (Spending cap exceeded). Vui lòng cập nhật API Key mới trong phần Cài đặt hoặc kiểm tra lại thanh toán Google Cloud của bạn.");
      } else if (errorMessage.includes("503") || errorMessage.includes("high demand") || errorMessage.includes("UNAVAILABLE")) {
        setError("Hệ thống AI đang quá tải (High demand). Vui lòng đợi vài giây rồi bấm 'Kiểm tra ngay' lại nhé sếp!");
      } else if (errorMessage.includes("Load failed") || errorMessage.includes("TypeError")) {
        setError("Lỗi kết nối mạng: Không thể kết nối tới máy chủ AI. Vui lòng kiểm tra lại mạng hoặc thử lại sau ít phút nhé sếp!");
      } else {
        setError(`Lỗi phân tích: ${errorMessage}`);
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const deleteHistoryItem = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!user) return;
    
    try {
      await deleteDoc(doc(db, 'history', id));
      if (currentHistoryId === id) {
        reset();
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `history/${id}`);
    }
  };

  const reset = () => {
    setImages([]);
    setResult(null);
    setCurrentHistoryId(null);
    setError(null);
    setIsAnalyzing(false);
    setIsUploading(false);
    setChatMessages([]);
    setChatInput('');
    setIsChatOpen(false);
  };

  const selectHistoryItem = (item: HistoryItem) => {
    setShowHistory(false);
    if (item.images) {
      setImages(item.images);
    } else if ((item as any).image) {
      setImages([(item as any).image]);
    }
    
    if (item.status === 'processing') {
      setResult(null);
      setIsAnalyzing(true);
    } else {
      setResult(item.result);
      setIsAnalyzing(false);
    }
    
    setCurrentHistoryId(item.id);
    setError(null);
    setShowHistory(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const exportToPDF = async () => {
    if (!result) return;
    try {
      const { jsPDF } = await import('jspdf');
      const autoTable = (await import('jspdf-autotable')).default;
      
      const doc = new jsPDF();
      
      // Load Roboto font from cdnjs to support Vietnamese
      const fontUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/fonts/Roboto/Roboto-Regular.ttf'; // Roboto Regular
      const fontBoldUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/fonts/Roboto/Roboto-Medium.ttf'; // Roboto Bold
      
      try {
        const [regRes, boldRes] = await Promise.all([fetch(fontUrl), fetch(fontBoldUrl)]);
        const [regBuf, boldBuf] = await Promise.all([regRes.arrayBuffer(), boldRes.arrayBuffer()]);
        
        const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
          let binary = '';
          const bytes = new Uint8Array(buffer);
          const len = bytes.byteLength;
          for (let i = 0; i < len; i++) {
              binary += String.fromCharCode(bytes[i]);
          }
          return window.btoa(binary);
        };

        doc.addFileToVFS('Roboto-Regular.ttf', arrayBufferToBase64(regBuf));
        doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal');
        
        doc.addFileToVFS('Roboto-Bold.ttf', arrayBufferToBase64(boldBuf));
        doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold');
        
        doc.setFont('Roboto');
      } catch (fontErr) {
        console.error("Could not load custom font, falling back to default", fontErr);
      }
      
      // Parse result JSON
      let invoiceResult: InvoiceResult;
      try {
        const parsed = JSON.parse(result);
        if (parsed && typeof parsed === 'object') {
          if ('invoices' in parsed && Array.isArray(parsed.invoices)) {
            invoiceResult = parsed;
          } else if ('items' in parsed && 'summary' in parsed) {
            // Fallback for old single invoice format
            invoiceResult = { invoices: [parsed] };
          } else {
            throw new Error("Invalid format");
          }
        } else {
          throw new Error("Invalid format");
        }
      } catch (e) {
        setError("Dữ liệu không hợp lệ để xuất PDF.");
        return;
      }

      invoiceResult.invoices.forEach((invoiceData, idx) => {
        if (idx > 0) {
          doc.addPage();
        }

        doc.setFont("Roboto", "bold");
        doc.setFontSize(18);
        doc.text(invoiceResult.invoices.length > 1 ? `HÓA ĐƠN NHẬP HÀNG ${idx + 1}` : "HÓA ĐƠN NHẬP HÀNG", 105, 20, { align: "center" });
        
        doc.setFont("Roboto", "normal");
        doc.setFontSize(11);
        doc.text(`Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`, 105, 28, { align: "center" });

        // Prepare table data
        const tableBody = invoiceData.items.map((item: any, index: number) => {
          const isCorrect = item.calculatedTotal === item.billTotal;
          const discrepancy = !isCorrect && item.billTotal !== undefined 
            ? ` (Lệch: ${formatCurrency(item.calculatedTotal - item.billTotal)})` 
            : '';

          return [
            index + 1,
            item.name,
            item.quantity,
            formatCurrency(item.unitPrice),
            formatCurrency(item.calculatedTotal) + discrepancy
          ];
        });

        autoTable(doc, {
          startY: 40,
          head: [['STT', 'Tên hàng', 'SL', 'Đơn giá', 'Thành tiền (Tính lại)']],
          body: tableBody,
          theme: 'grid',
          headStyles: { fillColor: [244, 63, 94], font: 'Roboto', fontStyle: 'bold' },
          styles: { font: 'Roboto', fontStyle: 'normal' }
        });

        let finalY = (doc as any).lastAutoTable.finalY || 40;
        
        doc.setFontSize(11);

        // Summary
        finalY += 10;
        if (invoiceData.summary.billTotal !== undefined) {
          doc.text(`Cộng tiền hàng (ghi trên bill): ${formatCurrency(invoiceData.summary.billTotal)}`, 14, finalY);
          finalY += 7;
        }
        doc.setFont("Roboto", "bold");
        doc.text(`Cộng tiền hàng (tính lại): ${formatCurrency(invoiceData.summary.calculatedTotal)}`, 14, finalY);
        doc.setFont("Roboto", "normal");
        
        const isSubTotalCorrect = invoiceData.summary.billTotal === undefined || invoiceData.summary.calculatedTotal === invoiceData.summary.billTotal;
        if (!isSubTotalCorrect && invoiceData.summary.billTotal !== undefined) {
          finalY += 7;
          doc.setTextColor(220, 38, 38); // Red
          doc.text(`Lệch tiền hàng: ${formatCurrency(invoiceData.summary.calculatedTotal - invoiceData.summary.billTotal)}`, 14, finalY);
          doc.setTextColor(0, 0, 0);
        }

        if (invoiceData.summary.adjustments && invoiceData.summary.adjustments.length > 0) {
          finalY += 5;
          invoiceData.summary.adjustments.forEach((adj: any) => {
            finalY += 7;
            const desc = adj.description ? adj.description : (adj.type === 'add' ? 'Cộng thêm' : 'Trừ đi');
            const sign = adj.type === 'add' ? '+' : '-';
            doc.text(`${desc}: ${sign}${formatCurrency(adj.amount)}`, 14, finalY);
          });
          
          finalY += 10;
          if (invoiceData.summary.finalBillTotal !== undefined) {
            doc.text(`Tổng cộng cuối (ghi trên bill): ${formatCurrency(invoiceData.summary.finalBillTotal)}`, 14, finalY);
            finalY += 7;
          }
          
          doc.setFont("Roboto", "bold");
          doc.text(`Tổng cộng cuối (tính lại): ${formatCurrency(invoiceData.summary.finalCalculatedTotal)}`, 14, finalY);
          doc.setFont("Roboto", "normal");
          
          const isFinalTotalCorrect = invoiceData.summary.finalBillTotal === undefined || invoiceData.summary.finalCalculatedTotal === invoiceData.summary.finalBillTotal;
          if (!isFinalTotalCorrect && invoiceData.summary.finalBillTotal !== undefined) {
            finalY += 7;
            doc.setTextColor(220, 38, 38);
            doc.text(`Lệch tổng cuối: ${formatCurrency(invoiceData.summary.finalCalculatedTotal - invoiceData.summary.finalBillTotal)}`, 14, finalY);
            doc.setTextColor(0, 0, 0);
          }
        }
      });

      doc.save(`Hoa_Don_Nhap_Hang_${new Date().getTime()}.pdf`);
    } catch (err) {
      console.error("PDF export error:", err);
      setError("Lỗi khi xuất file PDF. Vui lòng thử lại.");
    }
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] font-sans selection:bg-rose-200 safe-area-pb">
      {/* iOS Install Guide */}
      <AnimatePresence>
        {showInstallGuide && (
          <motion.div
            initial={{ y: -100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -100, opacity: 0 }}
            className="fixed top-0 left-0 right-0 z-50 px-4 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)] glass-panel-dark text-white"
          >
            <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/10 rounded-[20px] flex items-center justify-center shrink-0">
                  <Upload size={20} strokeWidth={1.5} className="rotate-180" />
                </div>
                <div className="text-sm">
                  <p className="font-bold">Cài đặt Mận Quý trên iPhone</p>
                  <p className="opacity-70">Nhấn nút <span className="font-bold">Chia sẻ</span> rồi chọn <span className="font-bold">"Thêm vào MH chính"</span></p>
                </div>
              </div>
              <button 
                onClick={() => setShowInstallGuide(false)}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X size={20} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <AnimatePresence>
        {uploadSuccess && (
          <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 bg-green-500 text-white px-6 py-3 rounded-full shadow-lg flex items-center gap-2"
          >
            <CheckCircle2 size={20} />
            <span className="font-medium">Đã tải ảnh lên! Sếp có thể tắt app, kết quả sẽ tự lưu vào lịch sử.</span>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="glass-panel fixed top-0 left-0 right-0 z-20 border-b-0 border-white/40 safe-area-pt">
          <div className="max-w-4xl mx-auto px-3 py-3 sm:px-6 sm:py-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
              <Logo 
                className="h-12 sm:h-16 w-auto transition-transform hover:scale-105 active:scale-95" 
                onClick={reset}
              />
              <div 
                className="hidden flex items-center gap-2 sm:gap-3 min-w-0 shrink-0 cursor-pointer transition-transform hover:scale-105 active:scale-95"
                onClick={reset}
                title="Làm mới ứng dụng"
              >
                <div className="w-8 h-8 sm:w-10 sm:h-10 bg-gradient-primary rounded-[16px] sm:rounded-[20px] flex items-center justify-center text-white shadow-[0_8px_16px_rgba(244,63,94,0.2)] shrink-0">
                  <Calculator size={18} className="sm:w-[22px] sm:h-[22px]" strokeWidth={1.5} />
                </div>
                <h1 className="text-base sm:text-xl font-semibold tracking-tight truncate hidden xs:block">Tính Toán</h1>
              </div>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">
              {serverKey ? (
                <div className="flex items-center gap-1.5 px-2 py-1.5 sm:px-4 sm:py-2 bg-green-500/10 text-green-700 rounded-full text-[11px] sm:text-xs font-medium border border-green-500/20 backdrop-blur-md" title="Hệ thống đã kết nối">
                  <CheckCircle2 size={14} strokeWidth={1.5} />
                  <span className="hidden sm:inline">Hệ thống đã kết nối</span>
                </div>
              ) : hasAIStudioKey === false && window.aistudio && (
                <button
                  onClick={handleOpenAIStudioKey}
                  className="flex items-center gap-1.5 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2 bg-amber-500/10 text-amber-700 rounded-full text-[12px] sm:text-sm font-medium hover:bg-amber-500/20 transition-all border border-amber-500/20 backdrop-blur-md active:scale-[0.97]"
                  title="Chọn API Key"
                >
                  <Key size={14} className="sm:w-4 sm:h-4" strokeWidth={1.5} />
                  <span className="hidden sm:inline">Chọn API Key</span>
                </button>
              )}
              <button
                onClick={() => setShowSettings(true)}
                className={cn(
                  "flex items-center gap-1.5 sm:gap-2 px-2 py-1.5 sm:px-4 sm:py-2 rounded-full text-[12px] sm:text-sm font-medium transition-all border backdrop-blur-md active:scale-[0.97]",
                  manualKey 
                    ? "bg-rose-500/10 text-rose-700 border-rose-500/20 hover:bg-rose-500/20" 
                    : "bg-white/50 text-gray-700 border-white/60 hover:bg-white/80"
                )}
                title="Cấu hình API Key"
              >
                <Settings size={14} className="sm:w-4 sm:h-4" />
                <span className="hidden sm:inline">{manualKey ? 'Custom API' : 'Cấu hình API'}</span>
              </button>
              {user ? (
                <div className="flex items-center gap-1.5 sm:gap-3">
                  <div className="flex items-center gap-1.5 sm:gap-2">
                    <img src={user.photoURL || ''} alt={user.displayName || ''} className="w-8 h-8 sm:w-9 sm:h-9 rounded-full border-2 border-white shadow-sm" />
                    <button onClick={logout} className="p-1.5 sm:p-2 hover:bg-red-500/10 text-red-500 rounded-full transition-all active:scale-[0.97]" title="Đăng xuất">
                      <LogOut size={18} className="sm:w-5 sm:h-5" strokeWidth={1.5} />
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={login}
                  className="relative group flex items-center gap-2 px-4 py-2 sm:px-6 sm:py-2.5 bg-gradient-to-r from-rose-500 to-orange-500 text-white rounded-full text-sm font-bold transition-all shadow-[0_8px_16px_rgba(244,63,94,0.3)] hover:shadow-[0_12px_24px_rgba(244,63,94,0.5)] hover:-translate-y-0.5 active:scale-[0.97]"
                >
                  <div className="absolute inset-0 rounded-full bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                  <div className="absolute -inset-1 rounded-full bg-gradient-to-r from-rose-500 to-orange-500 opacity-30 blur-sm group-hover:opacity-50 transition-opacity animate-pulse"></div>
                  <LogIn size={18} strokeWidth={2.5} className="relative z-10" />
                  <span className="relative z-10">ĐĂNG NHẬP</span>
                </button>
              )}
              {images.length > 0 && (
                <button
                  onClick={reset}
                  className="p-1.5 sm:p-2 hover:bg-white/60 rounded-full transition-all text-[#666] active:scale-[0.97]"
                  title="Xóa tất cả"
                >
                  <RefreshCw size={16} className="sm:w-5 sm:h-5" strokeWidth={1.5} />
                </button>
              )}
            </div>
          </div>
        </header>

      <main className={cn(
        "max-w-4xl mx-auto px-4 pb-6 sm:px-6 sm:pb-12 transition-all duration-300 pt-[calc(env(safe-area-inset-top)+6rem)] sm:pt-[calc(env(safe-area-inset-top)+8rem)]"
      )}>
        <div className="grid gap-8 sm:gap-12">
          {/* Action Area */}
          <section className="space-y-6 sm:space-y-8">
            <div className="text-center space-y-2">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight md:text-4xl bg-clip-text text-transparent bg-gradient-to-r from-red-500 via-pink-500 via-blue-500 to-yellow-500 drop-shadow-sm">Tính Toán Hóa Đơn</h2>
              <p className="text-[#666] max-w-lg mx-auto text-sm sm:text-base">
                Chào sếp Huy Đẹp Trai :) Chúc Sếp Ngày Mới Thành Công, Bán Hàng Đắt Khách
              </p>
            </div>

            {images.length === 0 ? (
              <div className="space-y-4 max-w-md mx-auto w-full">
                <div className="grid grid-cols-2 gap-3 sm:gap-4">
                  <motion.button
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { triggerExternalAction(); cameraInputRef.current?.click(); }}
                    className="flex flex-col items-center justify-center p-6 sm:p-8 glass-panel rounded-[24px] sm:rounded-[32px] hover:bg-white/80 transition-all group"
                  >
                    <div className="w-12 h-12 sm:w-14 sm:h-14 bg-white/50 rounded-[18px] sm:rounded-[22px] shadow-sm flex items-center justify-center mb-2 sm:mb-3 group-hover:bg-gradient-primary group-hover:text-white transition-all duration-300">
                      <Camera size={24} className="sm:w-7 sm:h-7" strokeWidth={1.5} />
                    </div>
                    <span className="font-semibold text-sm sm:text-base tracking-tight">Chụp ảnh</span>
                    <input
                      type="file"
                      ref={cameraInputRef}
                      onChange={handleFileUpload}
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                    />
                  </motion.button>

                  <motion.button
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { triggerExternalAction(); fileInputRef.current?.click(); }}
                    className="flex flex-col items-center justify-center p-6 sm:p-8 glass-panel rounded-[24px] sm:rounded-[32px] hover:bg-white/80 transition-all group"
                  >
                    <div className="w-12 h-12 sm:w-14 sm:h-14 bg-white/50 rounded-[18px] sm:rounded-[22px] shadow-sm flex items-center justify-center mb-2 sm:mb-3 group-hover:bg-gradient-primary group-hover:text-white transition-all duration-300">
                      <Upload size={24} className="sm:w-7 sm:h-7" strokeWidth={1.5} />
                    </div>
                    <span className="font-semibold text-sm sm:text-base tracking-tight">Tải ảnh lên</span>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      multiple
                      accept="image/jpeg,image/png,image/bmp,image/gif"
                      className="hidden"
                    />
                  </motion.button>
                </div>


              </div>
            ) : null}

            {/* Image Preview & Analysis */}
            {images.length > 0 && (
              <div className="space-y-6">
                <div className="flex flex-wrap justify-center gap-3 sm:gap-4">
                  {images.length > 0 && (
                    <div className="relative group cursor-pointer aspect-square w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] md:w-[calc(25%-0.75rem)] lg:w-[calc(20%-0.8rem)]" onClick={() => setZoomedImageIndex(0)}>
                      <div className="w-full h-full rounded-2xl overflow-hidden relative shadow-sm border border-[#E5E5E5]">
                        <img
                          src={images[0]}
                          alt="Preview"
                          className="w-full h-full object-cover hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <ZoomIn className="text-white" size={20} />
                        </div>
                        {images.length > 1 && (
                          <div className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] sm:text-xs font-bold px-2 py-1 rounded-lg backdrop-blur-md shadow-sm border border-white/20">
                            +{images.length - 1} ảnh
                          </div>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setImages([]);
                        }}
                        className="absolute -top-2 -right-2 p-1.5 bg-white text-red-500 rounded-full shadow-lg border border-red-50 hover:bg-red-50 transition-colors z-10"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                  
                  {/* Add more & History buttons in grid */}
                  <div className="aspect-square flex flex-col gap-2 sm:gap-3 w-[calc(50%-0.375rem)] sm:w-[calc(33.333%-0.667rem)] md:w-[calc(25%-0.75rem)] lg:w-[calc(20%-0.8rem)]">
                    <motion.button
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => { triggerExternalAction(); fileInputRef.current?.click(); }}
                      className="flex-1 flex flex-col items-center justify-center glass-panel rounded-2xl sm:rounded-3xl hover:bg-white/80 transition-all group text-[#666]"
                    >
                      <Upload size={20} strokeWidth={1.5} className="mb-0.5" />
                      <span className="text-[10px] sm:text-xs font-bold tracking-tight">Thay ảnh</span>
                    </motion.button>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileUpload}
                      multiple
                      accept="image/jpeg,image/png,image/bmp,image/gif"
                      className="hidden"
                    />
                    

                  </div>
                </div>

                {/* Zoom Modal */}
                <AnimatePresence>
                  {zoomedImageIndex !== null && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex flex-col"
                      onClick={() => setZoomedImageIndex(null)}
                    >
                      <div className="absolute top-0 left-0 right-0 flex justify-between items-center p-4 z-10">
                        <div className="text-white/70 text-sm font-medium px-4">
                          {zoomedImageIndex + 1} / {images.length}
                        </div>
                        <button
                          onClick={() => setZoomedImageIndex(null)}
                          className="p-2 text-white hover:text-white/70 transition-colors bg-black/20 rounded-full"
                        >
                          <X size={28} strokeWidth={2} />
                        </button>
                      </div>
                      
                      <div 
                        id="zoom-scroll-container"
                        className="flex-1 overflow-x-auto flex snap-x snap-mandatory hide-scrollbar"
                        onClick={() => setZoomedImageIndex(null)}
                        onScroll={(e) => {
                          const container = e.currentTarget;
                          const scrollLeft = container.scrollLeft;
                          const width = container.clientWidth;
                          if (width === 0) return;
                          const newIndex = Math.round(scrollLeft / width);
                          if (zoomedImageIndex !== null && newIndex !== zoomedImageIndex) {
                            setZoomedImageIndex(newIndex);
                          }
                        }}
                      >
                        {images.map((img, idx) => (
                          <div key={idx} className="w-full h-full flex-shrink-0 flex items-center justify-center p-4 snap-center">
                            <img
                              src={img}
                              alt={`Preview ${idx + 1}`}
                              className="max-w-full max-h-[90vh] object-contain rounded-xl"
                            />
                          </div>
                        ))}
                      </div>
                      
                      {/* Navigation Buttons for Desktop */}
                      {images.length > 1 && (
                        <>
                          <button 
                            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 text-white rounded-full hover:bg-black/80 hidden sm:block disabled:opacity-30 disabled:hover:bg-black/50 transition-all"
                            onClick={(e) => {
                              e.stopPropagation();
                              const newIdx = Math.max(0, zoomedImageIndex - 1);
                              setZoomedImageIndex(newIdx);
                              document.getElementById('zoom-scroll-container')?.scrollTo({ left: newIdx * window.innerWidth, behavior: 'smooth' });
                            }}
                            disabled={zoomedImageIndex === 0}
                          >
                            <ChevronLeft size={24} />
                          </button>
                          <button 
                            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 text-white rounded-full hover:bg-black/80 hidden sm:block disabled:opacity-30 disabled:hover:bg-black/50 transition-all"
                            onClick={(e) => {
                              e.stopPropagation();
                              const newIdx = Math.min(images.length - 1, zoomedImageIndex + 1);
                              setZoomedImageIndex(newIdx);
                              document.getElementById('zoom-scroll-container')?.scrollTo({ left: newIdx * window.innerWidth, behavior: 'smooth' });
                            }}
                            disabled={zoomedImageIndex === images.length - 1}
                          >
                            <ChevronRight size={24} />
                          </button>
                        </>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {!result && (
                  <button
                    onClick={analyzeImage}
                    disabled={isAnalyzing || isUploading}
                    className={cn(
                      "w-full py-4 sm:py-5 rounded-[24px] sm:rounded-[32px] font-semibold text-base sm:text-lg flex items-center justify-center gap-2 sm:gap-3 transition-all",
                      (isAnalyzing || isUploading)
                        ? "bg-white/50 text-[#999] cursor-not-allowed backdrop-blur-md"
                        : "bg-gradient-primary text-white shadow-[0_8px_16px_rgba(244,63,94,0.2)] active:scale-[0.97]"
                    )}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="animate-spin" size={24} strokeWidth={1.5} />
                        Đang tải ảnh lên...
                      </>
                    ) : isAnalyzing ? (
                      <>
                        <Loader2 className="animate-spin" size={24} strokeWidth={1.5} />
                        Đang phân tích (Sếp có thể tắt app)...
                      </>
                    ) : (
                      <>
                        <Calculator size={24} strokeWidth={1.5} />
                        Kiểm tra ngay
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Results Area */}
          <AnimatePresence>
            {(result || error || isAnalyzing) && (
              <motion.section
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                <div className="flex items-center gap-2 text-[#666] uppercase tracking-widest text-xs font-bold">
                  <div className="h-px flex-1 bg-[#E5E5E5]" />
                  <span>Báo cáo tính toán</span>
                  <div className="h-px flex-1 bg-[#E5E5E5]" />
                </div>

                {error ? (
                  <div className="p-6 bg-red-50 border border-red-100 rounded-3xl text-red-600 flex flex-col gap-4">
                    <div className="flex items-center gap-3">
                      <AlertCircle size={24} />
                      <div className="flex-1">
                        {error === "API_KEY_MISSING" ? (
                          <div className="space-y-2">
                            <p className="font-bold">Chưa cấu hình API Key</p>
                            <p className="text-sm opacity-90">Vui lòng nhấn nút bên dưới để chọn hoặc tạo API Key cho ứng dụng từ AI Studio.</p>
                          </div>
                        ) : (
                          <p>{error}</p>
                        )}
                      </div>
                      <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-full transition-colors">
                        <X size={20} />
                      </button>
                    </div>
                    {error && (
                      <div className="space-y-4">
                        {error.includes("API Key") && window.aistudio && !serverKey ? (
                          <button
                            onClick={handleOpenAIStudioKey}
                            className="flex items-center justify-center gap-2 w-full py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md active:scale-95"
                          >
                            <Key size={18} />
                            Chọn API Key ngay
                          </button>
                        ) : error.includes("API Key") && !serverKey ? (
                          <div className="space-y-3 bg-white p-4 rounded-2xl border border-red-100 shadow-sm">
                            <p className="text-xs text-gray-500 font-medium">Bạn đang dùng bản chia sẻ. Vui lòng dán API Key Gemini của bạn để tiếp tục:</p>
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={manualKey}
                                onChange={(e) => {
                                  setManualKey(e.target.value);
                                  localStorage.setItem('manquy_api_key', e.target.value);
                                }}
                                placeholder="Dán API Key tại đây..."
                                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-red-500 outline-none"
                              />
                              <button
                                onClick={() => {
                                  if (manualKey.trim()) {
                                    setError(null);
                                    analyzeImage();
                                  }
                                }}
                                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700"
                              >
                                Dùng Key này
                              </button>
                            </div>
                            <a 
                              href="https://aistudio.google.com/app/apikey" 
                              target="_blank" 
                              rel="noreferrer"
                              onClick={triggerExternalAction}
                              className="text-[10px] text-pink-600 hover:underline block text-center"
                            >
                              Chưa có Key? Lấy miễn phí tại đây (Google AI Studio)
                            </a>
                          </div>
                        ) : (
                          <div className="p-4 bg-red-50 text-red-700 rounded-2xl text-sm border border-red-100">
                            {error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4 sm:space-y-6">
                    {/* Image Comparison Area */}
                    {images.length > 0 && (
                      <div className="glass-panel rounded-[24px] sm:rounded-[32px] p-2 sm:p-3 overflow-hidden">
                        <div className="flex gap-3 overflow-x-auto pb-2 snap-x scrollbar-hide">
                          {images.map((img, idx) => (
                            <div key={idx} className="relative min-w-full snap-center group cursor-pointer" onClick={() => setZoomedImageIndex(idx)}>
                              <img 
                                src={img} 
                                alt={`Hóa đơn ${idx + 1}`} 
                                className="w-full h-auto object-contain rounded-[18px] sm:rounded-[24px] shadow-sm hover:opacity-95 transition-opacity"
                                referrerPolicy="no-referrer"
                              />
                              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="p-3 bg-black/40 backdrop-blur-md rounded-full text-white shadow-lg">
                                  <ZoomIn size={24} strokeWidth={1.5} />
                                </div>
                              </div>
                              <div className="absolute top-4 right-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    triggerExternalAction();
                                    window.open(img, '_blank');
                                  }}
                                  className="p-2.5 bg-black/60 text-white rounded-full backdrop-blur-md hover:bg-black/80 transition-all shadow-lg"
                                  title="Xem ảnh gốc"
                                >
                                  <Maximize2 size={20} strokeWidth={1.5} />
                                </button>
                              </div>
                              {images.length > 1 && (
                                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/40 backdrop-blur-md text-white px-3 py-1 rounded-full text-[10px] font-bold tracking-widest uppercase">
                                  Ảnh {idx + 1} / {images.length}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="glass-panel rounded-[24px] sm:rounded-[32px] p-4 sm:p-8 overflow-x-auto relative">
                      <button
                        onClick={reset}
                        className="absolute top-4 right-4 sm:top-6 sm:right-6 p-2 bg-black/5 text-gray-500 hover:bg-black/10 hover:text-gray-800 rounded-full transition-colors z-10"
                        title="Đóng và quay lại màn hình chính"
                      >
                        <X size={20} strokeWidth={2} />
                      </button>
                      <InvoiceResultRenderer data={result || ""} onChange={setResult} />
                      {result && (
                        <div className="mt-6 sm:mt-8 flex flex-col gap-5 sm:gap-6">
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-rose-600 font-medium text-[13px] sm:text-sm bg-rose-500/10 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full border border-rose-500/20 w-fit">
                              <CheckCircle2 size={16} strokeWidth={1.5} />
                              <span>Dữ liệu được phân tích bởi AI</span>
                            </div>
                            {currentHistoryId && history.find(h => h.id === currentHistoryId)?.status === 'processing' && (
                              <div className="flex items-center gap-2 text-amber-600 font-medium text-[13px] sm:text-sm bg-amber-500/10 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full border border-amber-500/20 animate-pulse w-fit">
                                <Loader2 size={16} className="animate-spin" />
                                <span>Đang cập nhật kết quả mới nhất...</span>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap justify-center items-center gap-3 sm:gap-4 w-full pt-2">
                            <button
                              onClick={exportToPDF}
                              className="flex items-center gap-2 px-5 py-2.5 sm:px-6 sm:py-3 bg-gradient-to-r from-rose-500 to-pink-500 text-white rounded-full text-[13px] sm:text-sm font-semibold transition-all shadow-[0_8px_16px_rgba(244,63,94,0.2)] active:scale-[0.97]"
                            >
                              <FileText size={18} strokeWidth={1.5} />
                              Xuất PDF
                            </button>
                            <button
                              onClick={reset}
                              className="flex items-center gap-2 px-5 py-2.5 sm:px-6 sm:py-3 bg-white/60 hover:bg-white/80 text-gray-700 border border-gray-200/50 rounded-full text-[13px] sm:text-sm font-semibold transition-all shadow-sm active:scale-[0.97]"
                            >
                              <RefreshCw size={18} strokeWidth={1.5} />
                              Tính hóa đơn mới
                            </button>
                          </div>
                        </div>
                      )}
                      
                      {result && !user && (
                        <div className="mt-4 p-3 bg-amber-500/10 rounded-xl border border-amber-500/20 flex items-center gap-2 text-xs text-amber-700">
                          <AlertCircle size={14} strokeWidth={1.5} />
                          Vui lòng đăng nhập để lưu hiệu chỉnh vào cơ sở dữ liệu.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] will-change-opacity"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              transition={{ type: 'tween', duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md glass-panel z-[70] rounded-[32px] overflow-hidden flex flex-col max-h-[90vh] will-change-transform"
            >
              <div className="p-4 sm:p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md shrink-0">
                <div className="flex items-center gap-2">
                  <Key className="text-[#1D1D1F]" size={20} strokeWidth={1.5} />
                  <h3 className="text-lg font-semibold tracking-tight">Cấu hình API Key</h3>
                </div>
                <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-white/60 rounded-full transition-all active:scale-[0.97]">
                  <X size={20} strokeWidth={1.5} />
                </button>
              </div>
              <div className="p-5 sm:p-8 space-y-6 overflow-y-auto">
                <div className="space-y-4">
                  {serverKey && !manualKey && (
                    <div className="p-4 bg-green-50 border border-green-100 rounded-2xl flex items-start gap-3">
                      <CheckCircle2 className="text-green-600 mt-0.5" size={20} />
                      <div className="space-y-1">
                        <p className="text-sm font-bold text-green-800">Hệ thống đã kết nối</p>
                        <p className="text-xs text-green-700 leading-relaxed">
                          Ứng dụng đang sử dụng API Key mặc định của hệ thống. Bạn có thể nhập Key của riêng mình bên dưới nếu muốn.
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {!serverKey && !manualKey && (
                    <div className="p-4 bg-pink-50 border border-pink-100 rounded-2xl">
                      <p className="text-sm text-pink-800 leading-relaxed">
                        Vui lòng nhập Gemini API Key của bạn để sử dụng ứng dụng. Key này sẽ được lưu an toàn trên trình duyệt của bạn (localStorage).
                      </p>
                    </div>
                  )}

                  {window.aistudio && !serverKey && (
                    <button
                      onClick={async () => {
                        try {
                          await window.aistudio!.openSelectKey();
                          setShowSettings(false);
                          setError(null);
                        } catch (e) {
                          console.error("Key selection error:", e);
                        }
                      }}
                      className="flex items-center justify-center gap-2 w-full py-3 bg-white/50 border border-white/60 text-[#1D1D1F] rounded-[24px] font-semibold hover:bg-white/80 transition-all shadow-sm active:scale-[0.97] mb-4 backdrop-blur-md"
                    >
                      <RefreshCw size={18} strokeWidth={1.5} />
                      Chọn API Key từ AI Studio
                    </button>
                  )}

                  <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-[#666] ml-1">
                      Gemini API Key tùy chỉnh
                    </label>
                    <input
                      type="password"
                      value={manualKey}
                      onChange={(e) => {
                        setManualKey(e.target.value);
                      }}
                      placeholder="Dán API Key tại đây..."
                      className="w-full px-5 py-4 bg-white/50 border border-white/60 rounded-[24px] focus:ring-2 focus:ring-rose-500/50 outline-none transition-all backdrop-blur-md shadow-inner"
                    />
                  </div>
                  <button
                    onClick={() => {
                      if (manualKey.trim()) {
                        localStorage.setItem('manquy_api_key', manualKey.trim());
                        setShowSettings(false);
                        setError(null);
                      } else {
                        localStorage.removeItem('manquy_api_key');
                        setShowSettings(false);
                      }
                    }}
                    className="w-full py-4 bg-gradient-primary text-white rounded-full font-semibold transition-all shadow-[0_8px_16px_rgba(244,63,94,0.2)] active:scale-[0.97]"
                  >
                    Lưu và Đóng
                  </button>

                  <div className="pt-4 border-t border-gray-100 space-y-3">
                    <label className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-400 ml-1">
                      Hệ thống & Cập nhật
                    </label>
                    <button
                      onClick={() => {
                        if (confirm("Xác nhận xóa bộ nhớ đệm và tải lại ứng dụng để cập nhật bản mới nhất?")) {
                          if ('caches' in window) {
                            caches.keys().then((names) => {
                              for (let name of names) caches.delete(name);
                            });
                          }
                          window.location.reload();
                        }
                      }}
                      className="flex items-center justify-center gap-2 w-full py-3 bg-gray-50 text-gray-600 rounded-[20px] text-sm font-medium hover:bg-gray-100 transition-all active:scale-[0.98] border border-gray-100"
                    >
                      <RefreshCw size={16} strokeWidth={2} />
                      Xóa Cache & Tải lại ứng dụng
                    </button>
                    <div className="flex items-center justify-center gap-2 text-[10px] text-gray-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      Phiên bản: {localStorage.getItem('app_version') || '1.0.1'}
                    </div>
                  </div>
                  <a 
                    href="https://aistudio.google.com/app/apikey" 
                    target="_blank" 
                    rel="noreferrer"
                    onClick={triggerExternalAction}
                    className="text-xs text-pink-600 hover:underline block text-center mt-2"
                  >
                    Chưa có Key? Lấy miễn phí tại Google AI Studio
                  </a>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* History Drawer */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30 will-change-opacity"
            />
            <motion.div
              initial={{ x: '100%', opacity: 0.5 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'tween', duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
              className="fixed top-0 right-0 bottom-0 w-[85vw] sm:max-w-md glass-panel z-40 border-l border-white/40 flex flex-col safe-area-pt shadow-2xl will-change-transform"
            >
              <div className="p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md">
                <h3 className="text-xl font-semibold tracking-tight">Lịch sử phân tích</h3>
                <div className="flex items-center gap-2">
                  {history.length > 0 && (
                    <button
                      onClick={() => setShowDeleteAllHistoryConfirm(!showDeleteAllHistoryConfirm)}
                      className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                      title="Xóa toàn bộ lịch sử"
                    >
                      <Trash2 size={20} />
                    </button>
                  )}
                  <button 
                    onClick={() => setShowHistory(false)}
                    className="p-2 hover:bg-white/40 rounded-full transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>
              </div>
              <div id="history-drawer-content" className="flex-1 overflow-y-auto p-6 space-y-4">
                {showDeleteAllHistoryConfirm && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="bg-red-50 border border-red-100 rounded-2xl p-4 mb-4"
                  >
                    <p className="text-xs text-red-800 font-medium mb-3">Xác nhận xóa toàn bộ lịch sử? Hành động này không thể hoàn tác.</p>
                    <div className="flex gap-2">
                      <button
                        disabled={isDeletingAllHistory}
                        onClick={handleDeleteAllHistory}
                        className="flex-1 py-2 bg-red-600 text-white text-xs font-bold rounded-xl hover:bg-red-700 transition-all disabled:opacity-50"
                      >
                        {isDeletingAllHistory ? 'Đang xóa...' : 'Xác nhận xóa'}
                      </button>
                      <button
                        onClick={() => setShowDeleteAllHistoryConfirm(false)}
                        className="flex-1 py-2 bg-white text-gray-600 text-xs font-bold rounded-xl border border-gray-200 hover:bg-gray-50 transition-all"
                      >
                        Hủy
                      </button>
                    </div>
                  </motion.div>
                )}

                {history.length === 0 ? (
                  <div className="text-center py-12 text-[#999]">
                    <History size={48} strokeWidth={1.5} className="mx-auto mb-4 opacity-20" />
                    <p>Chưa có lịch sử nào</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => selectHistoryItem(item)}
                      className="group relative bg-white/70 border border-white/60 rounded-[24px] p-4 cursor-pointer hover:bg-white/90 transition-shadow hover:shadow-md active:scale-[0.97]"
                    >
                      <div className="flex gap-4">
                        <div className="relative">
                          <img
                            src={item.images?.[0] || item.image}
                            alt="Thumbnail"
                            className="w-20 h-20 object-cover rounded-[16px] border border-white/60 shadow-sm"
                          />
                          {item.images && item.images.length > 1 && (
                            <div className="absolute -bottom-1 -right-1 bg-gradient-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-md shadow-sm">
                              +{item.images.length - 1}
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <p className="text-sm font-medium text-[#333]">
                            {(() => {
                              const ts = item.timestamp;
                              if (!ts) return '';
                              const date = ts.toDate ? ts.toDate() : new Date(ts);
                              return date.toLocaleString('vi-VN');
                            })()}
                          </p>
                          {item.status === 'processing' && (
                            <div className="flex items-center gap-1.5 text-[11px] text-amber-600 mt-1 font-medium animate-pulse">
                              <Loader2 size={12} className="animate-spin" />
                              <span>Đang xử lý...</span>
                            </div>
                          )}
                          {item.status === 'failed' && (
                            <div className="flex items-center gap-1.5 text-[11px] text-red-500 mt-1 font-medium">
                              <AlertCircle size={12} />
                              <span>Lỗi phân tích</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteHistory(item.id);
                        }}
                        className="absolute top-2 right-2 p-2 text-gray-400 hover:text-red-500 sm:opacity-0 sm:group-hover:opacity-100 transition-all z-10"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )))}
                </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Product Drawer */}
      <AnimatePresence>
        {showProducts && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowProducts(false)}
              className="fixed inset-0 bg-black/40 backdrop-blur-sm z-30 will-change-opacity"
            />
            <motion.div
              initial={{ x: '100%', opacity: 0.5 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'tween', duration: 0.4, ease: [0.32, 0.72, 0, 1] }}
              className="fixed top-0 right-0 bottom-0 w-[85vw] sm:max-w-md glass-panel z-40 border-l border-white/40 flex flex-col safe-area-pt shadow-2xl will-change-transform"
            >
              <div className="p-6 border-b border-white/40 flex items-center justify-between bg-white/40 backdrop-blur-md">
                <h3 className="text-xl font-semibold tracking-tight">Kho sản phẩm</h3>
                <button 
                  onClick={() => setShowProducts(false)}
                  className="p-2 hover:bg-white/40 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              <div id="product-drawer-content" className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Search Bar (Compact) */}
                <div className={cn(
                  "sticky top-0 z-10 bg-white/80 backdrop-blur-md p-2 -mx-6 mb-2 border-b border-white/40 transition-all",
                  (isSearching || showFilterPanel) && "bg-white shadow-sm"
                )}>
                  <div className="relative flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input 
                        type="text" 
                        placeholder="Tìm kiếm nhanh..." 
                        value={searchQuery}
                        onFocus={() => setIsSearching(true)}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-8 pr-4 py-1.5 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 transition-all bg-white shadow-sm"
                      />
                    </div>
                    <button 
                      onClick={() => setShowFilterPanel(!showFilterPanel)}
                      className={cn(
                        "p-2 rounded-xl border transition-all",
                        showFilterPanel || selectedCategory || minPrice || maxPrice || sortBy !== 'name'
                          ? "bg-blue-50 border-blue-200 text-blue-600"
                          : "bg-white border-gray-200 text-gray-400 hover:text-gray-600"
                      )}
                      title="Bộ lọc"
                    >
                      <Filter size={14} />
                    </button>
                    {isSearching && (
                      <button 
                        onClick={() => {
                          setIsSearching(false);
                          setSearchQuery('');
                        }}
                        className="px-2 py-1 text-[10px] font-bold text-gray-500 hover:text-rose-500 transition-colors"
                      >
                        Hủy
                      </button>
                    )}
                  </div>

                  {/* Filter Panel */}
                  <AnimatePresence>
                    {showFilterPanel && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                      >
                        <div className="pt-3 pb-2 space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            {/* Category Filter */}
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Danh mục</label>
                              <select 
                                value={selectedCategory || ''} 
                                onChange={(e) => setSelectedCategory(e.target.value || null)}
                                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 bg-white"
                              >
                                <option value="">Tất cả danh mục</option>
                                {categories.map(cat => (
                                  <option key={cat} value={cat}>{cat}</option>
                                ))}
                              </select>
                            </div>

                            {/* Sort By */}
                            <div className="space-y-1">
                              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Sắp xếp</label>
                              <select 
                                value={sortBy} 
                                onChange={(e) => setSortBy(e.target.value as any)}
                                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 bg-white"
                              >
                                <option value="name">Tên A-Z</option>
                                <option value="price-asc">Giá thấp → cao</option>
                                <option value="price-desc">Giá cao → thấp</option>
                                <option value="newest">Mới nhất</option>
                              </select>
                            </div>

                            {/* Price Range */}
                            <div className="col-span-2 space-y-1">
                              <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Khoảng giá (VNĐ)</label>
                              <div className="flex items-center gap-2">
                                <input 
                                  type="number" 
                                  placeholder="Từ" 
                                  value={minPrice || ''}
                                  onChange={(e) => setMinPrice(e.target.value ? Number(e.target.value) : null)}
                                  className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 bg-white"
                                />
                                <span className="text-gray-400 text-xs">-</span>
                                <input 
                                  type="number" 
                                  placeholder="Đến" 
                                  value={maxPrice || ''}
                                  onChange={(e) => setMaxPrice(e.target.value ? Number(e.target.value) : null)}
                                  className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 bg-white"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="flex justify-end">
                            <button 
                              onClick={() => {
                                setSelectedCategory(null);
                                setMinPrice(null);
                                setMaxPrice(null);
                                setSortBy('name');
                              }}
                              className="text-[10px] font-bold text-rose-500 hover:text-rose-600 transition-colors"
                            >
                              Đặt lại bộ lọc
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Admin Controls Section */}
                {isAdmin && (
                  <div className="grid grid-cols-1 gap-2">
                    {/* Manual Add Button */}
                    <div className="space-y-2">
                      <button
                        onClick={() => setShowManualAdd(!showManualAdd)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/60 rounded-xl border border-white/80 shadow-sm hover:bg-white/80 transition-all"
                      >
                        <div className="flex items-center gap-2 font-bold text-xs text-gray-700">
                          <PlusCircle size={14} className="text-blue-600" />
                          Thêm sản phẩm thủ công
                        </div>
                        <ChevronDown size={14} className={cn("text-gray-400 transition-transform", showManualAdd && "rotate-180")} />
                      </button>

                      <AnimatePresence>
                        {showManualAdd && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="bg-white/60 p-4 rounded-xl border border-white/80 shadow-sm space-y-3 mb-2">
                              <div className="grid grid-cols-2 gap-2">
                                <input 
                                  type="text" 
                                  placeholder="Tên nệm" 
                                  id="new-p-name"
                                  className="col-span-2 px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <input 
                                  type="text" 
                                  placeholder="Kích thước (vd: 1m6x2m)" 
                                  id="new-p-size"
                                  className="px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <input 
                                  type="text" 
                                  placeholder="Độ dày (vd: 10cm)" 
                                  id="new-p-thickness"
                                  className="px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <input 
                                  type="number" 
                                  placeholder="Giá bán" 
                                  id="new-p-price"
                                  className="px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <input 
                                  type="text" 
                                  placeholder="Đơn vị (vd: Cái)" 
                                  id="new-p-unit"
                                  className="px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <input 
                                  type="text" 
                                  placeholder="Danh mục (vd: Nệm)" 
                                  id="new-p-category"
                                  className="col-span-2 px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500"
                                />
                                <textarea 
                                  placeholder="Thuộc tính khác (VD: Màu: Xanh; Chất liệu: Cao su)" 
                                  id="new-p-attrs"
                                  className="col-span-2 px-3 py-2 rounded-xl border border-gray-200 text-xs outline-none focus:border-blue-500 min-h-[60px]"
                                />
                              </div>
                              <button
                                onClick={async () => {
                                  const name = (document.getElementById('new-p-name') as HTMLInputElement).value;
                                  const price = parseInt((document.getElementById('new-p-price') as HTMLInputElement).value);
                                  const size = (document.getElementById('new-p-size') as HTMLInputElement).value;
                                  const thickness = (document.getElementById('new-p-thickness') as HTMLInputElement).value;
                                  const unit = (document.getElementById('new-p-unit') as HTMLInputElement).value;
                                  const category = (document.getElementById('new-p-category') as HTMLInputElement).value;
                                  const attrsStr = (document.getElementById('new-p-attrs') as HTMLTextAreaElement).value;
                                  
                                  if (!name || isNaN(price)) {
                                    alert("Vui lòng nhập ít nhất tên và giá!");
                                    return;
                                  }
                                  
                                  setIsSavingProduct(true);
                                  try {
                                    const attrs: Record<string, string> = {};
                                    if (attrsStr) {
                                      attrsStr.split(/[;,\n|]/).forEach(p => {
                                        const [k, v] = p.split(':').map(s => s.trim());
                                        if (k && v) attrs[k] = v;
                                        else if (k) attrs[k] = 'Có';
                                      });
                                    }

                                    let fullName = name;
                                    if (size && !fullName.toLowerCase().includes(size.toLowerCase())) fullName += ` ${size}`;
                                    if (thickness && !fullName.toLowerCase().includes(thickness.toLowerCase())) fullName += ` ${thickness}`;
                                    
                                    await addDoc(collection(db, 'products'), {
                                      uid: user!.uid,
                                      name: fullName,
                                      price,
                                      size,
                                      thickness,
                                      unit,
                                      category: category || guessCategory(fullName),
                                      attributes: attrs,
                                      createdAt: serverTimestamp(),
                                      updatedAt: serverTimestamp()
                                    });
                                    
                                    (document.getElementById('new-p-name') as HTMLInputElement).value = '';
                                    (document.getElementById('new-p-price') as HTMLInputElement).value = '';
                                    (document.getElementById('new-p-size') as HTMLInputElement).value = '';
                                    (document.getElementById('new-p-thickness') as HTMLInputElement).value = '';
                                    (document.getElementById('new-p-unit') as HTMLInputElement).value = '';
                                    (document.getElementById('new-p-attrs') as HTMLTextAreaElement).value = '';
                                    
                                  } catch (err) {
                                    console.error(err);
                                  } finally {
                                    setIsSavingProduct(false);
                                  }
                                }}
                                disabled={isSavingProduct}
                                className="w-full bg-blue-500 text-white font-bold py-2 rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-xs"
                              >
                                {isSavingProduct ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                                Thêm vào kho
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Bulk Upload & Delete Section */}
                    <div className="space-y-2">
                      <button
                        onClick={() => setShowBulkUpload(!showBulkUpload)}
                        className="w-full flex items-center justify-between px-4 py-3 bg-white/60 rounded-xl border border-white/80 shadow-sm hover:bg-white/80 transition-all"
                      >
                        <div className="flex items-center gap-2 font-bold text-xs text-gray-700">
                          <FileText size={14} className="text-green-600" />
                          Thêm hàng loạt từ Excel
                        </div>
                        <ChevronDown size={14} className={cn("text-gray-400 transition-transform", showBulkUpload && "rotate-180")} />
                      </button>

                      <AnimatePresence>
                        {showBulkUpload && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="bg-white/60 p-4 rounded-xl border border-white/80 shadow-sm space-y-3 mb-2">
                              <p className="text-[10px] text-gray-500 leading-relaxed">
                                Tải lên file .xlsx chứa danh sách sản phẩm. File cần có các cột: <b>Tên sản phẩm</b>, <b>Giá Bán Chung</b>, <b>Kích Thước</b>, <b>Độ Dày</b>, <b>Đơn Vị Tính</b>.
                              </p>
                              <button
                                onClick={() => excelInputRef.current?.click()}
                                disabled={isSavingProduct}
                                className="w-full bg-green-500/10 text-green-700 font-bold py-2 rounded-xl hover:bg-green-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-xs border border-green-500/20"
                              >
                                {isSavingProduct ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                Chọn file Excel
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>

                      {!showDeleteAllConfirm ? (
                        <button
                          onClick={() => setShowDeleteAllConfirm(true)}
                          disabled={isSavingProduct || products.length === 0}
                          className="w-full bg-red-500/10 text-red-700 font-bold py-2 rounded-xl hover:bg-red-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-xs border border-red-500/20"
                        >
                          <Trash2 size={14} />
                          Xóa toàn bộ sản phẩm
                        </button>
                      ) : (
                        <div className="bg-red-50 p-3 rounded-xl border border-red-100 space-y-2">
                          <p className="text-[10px] text-red-600 font-bold text-center uppercase tracking-wider">Xác nhận xóa sạch kho hàng?</p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleDeleteAllProducts()}
                              disabled={isSavingProduct}
                              className="flex-1 bg-red-500 text-white text-[10px] font-bold py-2 rounded-lg hover:bg-red-600 transition-colors flex items-center justify-center gap-2"
                            >
                              {isSavingProduct ? <Loader2 size={12} className="animate-spin" /> : 'Xóa hết'}
                            </button>
                            <button
                              onClick={() => setShowDeleteAllConfirm(false)}
                              disabled={isSavingProduct}
                              className="flex-1 bg-white text-gray-600 text-[10px] font-bold py-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors"
                            >
                              Hủy
                            </button>
                          </div>
                        </div>
                      )}
                      <input
                        type="file"
                        ref={excelInputRef}
                        onChange={handleExcelUpload}
                        accept=".xlsx, .xls"
                        className="hidden"
                      />
                    </div>
                  </div>
                )}

                {/* Chatbot Knowledge Section (Admin Only) */}
                {isAdmin && (
                  <div className="space-y-2">
                    <button
                      onClick={() => setShowChatbotKnowledge(!showChatbotKnowledge)}
                      className="w-full flex items-center justify-between px-4 py-3 bg-white/60 rounded-xl border border-white/80 shadow-sm hover:bg-white/80 transition-all"
                    >
                      <div className="flex items-center gap-2 font-bold text-xs text-gray-700">
                        <Edit3 size={14} className="text-blue-600" />
                        Dạy chatbot thông tin mới
                      </div>
                      <ChevronDown size={14} className={cn("text-gray-400 transition-transform", showChatbotKnowledge && "rotate-180")} />
                    </button>

                    <AnimatePresence>
                      {showChatbotKnowledge && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="bg-white/60 p-4 rounded-xl border border-white/80 shadow-sm space-y-3 mb-2">
                            <div className="relative">
                              <textarea
                                placeholder="Nhập các thông tin bạn muốn chatbot ghi nhớ..."
                                value={chatbotKnowledge}
                                onChange={(e) => setChatbotKnowledge(e.target.value)}
                                className="w-full px-3 py-2 rounded-xl border border-gray-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 outline-none text-xs transition-all bg-white min-h-[100px] resize-none pr-8"
                              />
                              {chatbotKnowledge && (
                                <button 
                                  onClick={() => setChatbotKnowledge('')}
                                  className="absolute top-2 right-2 p-1 text-gray-400 hover:text-red-500 transition-colors"
                                  title="Xóa nội dung"
                                >
                                  <X size={14} />
                                </button>
                              )}
                            </div>
                            <button
                              onClick={async () => {
                                await handleSaveKnowledge();
                                setChatbotKnowledge('');
                              }}
                              disabled={isSavingKnowledge || !chatbotKnowledge.trim()}
                              className="w-full bg-blue-500 text-white font-bold py-2 rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-xs"
                            >
                              {isSavingKnowledge ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                              Lưu thông tin dạy chatbot
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                {/* Product List */}
                <div className="space-y-4">
                  {/* Category Chips - Grid Layout */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <button
                      onClick={() => setSelectedCategory(null)}
                      className={cn(
                        "px-3 py-2.5 rounded-xl text-[11px] font-bold transition-all border flex items-center justify-between gap-2",
                        selectedCategory === null
                          ? "bg-blue-500 text-white border-blue-500 shadow-lg shadow-blue-100"
                          : "bg-blue-50/50 text-blue-600 border-blue-100 hover:bg-blue-50"
                      )}
                    >
                      <span>Tất cả</span>
                      <span className={cn(
                        "px-1.5 py-0.5 rounded-lg text-[9px]",
                        selectedCategory === null ? "bg-white/20 text-white" : "bg-blue-100 text-blue-500"
                      )}>
                        {products.length}
                      </span>
                    </button>
                    {categories.map(cat => {
                      const count = products.filter(p => (p.category || guessCategory(p.name)) === cat).length;
                      const color = getCategoryColor(cat);
                      
                      // Dynamic color classes based on the category
                      const activeClasses: Record<string, string> = {
                        blue: "bg-blue-500 border-blue-500 shadow-blue-100",
                        green: "bg-green-500 border-green-500 shadow-green-100",
                        purple: "bg-purple-500 border-purple-500 shadow-purple-100",
                        orange: "bg-orange-500 border-orange-500 shadow-orange-100",
                        pink: "bg-pink-500 border-pink-500 shadow-pink-100",
                        cyan: "bg-cyan-500 border-cyan-500 shadow-cyan-100",
                        teal: "bg-teal-500 border-teal-500 shadow-teal-100",
                        indigo: "bg-indigo-500 border-indigo-500 shadow-indigo-100",
                        amber: "bg-amber-500 border-amber-500 shadow-amber-100",
                        slate: "bg-slate-500 border-slate-500 shadow-slate-100",
                        rose: "bg-rose-500 border-rose-500 shadow-rose-100",
                        gray: "bg-gray-500 border-gray-500 shadow-gray-100",
                      };

                      const inactiveClasses: Record<string, string> = {
                        blue: "bg-blue-50/50 text-blue-600 border-blue-100",
                        green: "bg-green-50/50 text-green-600 border-green-100",
                        purple: "bg-purple-50/50 text-purple-600 border-purple-100",
                        orange: "bg-orange-50/50 text-orange-600 border-orange-100",
                        pink: "bg-pink-50/50 text-pink-600 border-pink-100",
                        cyan: "bg-cyan-50/50 text-cyan-600 border-cyan-100",
                        teal: "bg-teal-50/50 text-teal-600 border-teal-100",
                        indigo: "bg-indigo-50/50 text-indigo-600 border-indigo-100",
                        amber: "bg-amber-50/50 text-amber-600 border-amber-100",
                        slate: "bg-slate-50/50 text-slate-600 border-slate-100",
                        rose: "bg-rose-50/50 text-rose-600 border-rose-100",
                        gray: "bg-gray-50/50 text-gray-600 border-gray-100",
                      };

                      const badgeClasses: Record<string, string> = {
                        blue: "bg-blue-100 text-blue-500",
                        green: "bg-green-100 text-green-500",
                        purple: "bg-purple-100 text-purple-500",
                        orange: "bg-orange-100 text-orange-500",
                        pink: "bg-pink-100 text-pink-500",
                        cyan: "bg-cyan-100 text-cyan-500",
                        teal: "bg-teal-100 text-teal-500",
                        indigo: "bg-indigo-100 text-indigo-500",
                        amber: "bg-amber-100 text-amber-500",
                        slate: "bg-slate-100 text-slate-500",
                        rose: "bg-rose-100 text-rose-500",
                        gray: "bg-gray-100 text-gray-400",
                      };

                      const hoverClasses: Record<string, string> = {
                        blue: "hover:bg-blue-50 hover:border-blue-200",
                        green: "hover:bg-green-50 hover:border-green-200",
                        purple: "hover:bg-purple-50 hover:border-purple-200",
                        orange: "hover:bg-orange-50 hover:border-orange-200",
                        pink: "hover:bg-pink-50 hover:border-pink-200",
                        cyan: "hover:bg-cyan-50 hover:border-cyan-200",
                        teal: "hover:bg-teal-50 hover:border-teal-200",
                        indigo: "hover:bg-indigo-50 hover:border-indigo-200",
                        amber: "hover:bg-amber-50 hover:border-amber-200",
                        slate: "hover:bg-slate-50 hover:border-slate-200",
                        rose: "hover:bg-rose-50 hover:border-rose-200",
                        gray: "hover:bg-gray-50 hover:border-gray-200",
                      };

                      return (
                        <button
                          key={cat}
                          onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                          className={cn(
                            "px-3 py-2.5 rounded-xl text-[11px] font-bold transition-all border flex items-center justify-between gap-2",
                            selectedCategory === cat
                              ? cn(activeClasses[color], "text-white shadow-lg")
                              : cn(inactiveClasses[color], hoverClasses[color])
                          )}
                        >
                          <span className="truncate">{cat}</span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded-lg text-[9px] shrink-0",
                            selectedCategory === cat ? "bg-white/20 text-white" : badgeClasses[color]
                          )}>
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex flex-col gap-3">
                    <h4 className="font-semibold text-sm text-gray-700 flex items-center justify-between">
                      Danh sách sản phẩm
                      <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full text-xs">{products.length}</span>
                    </h4>
                  </div>
                  
                  {products.length === 0 ? (
                    <div className="text-center py-8 text-[#999]">
                      <Package size={40} strokeWidth={1.5} className="mx-auto mb-3 opacity-20" />
                      <p className="text-sm">Chưa có sản phẩm nào</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {groupedProducts.map(([name, groupProducts]) => {
                        const isExpanded = expandedGroups[name] || (searchQuery.length > 0 && groupProducts.length < 5);
                        const hasMultiple = groupProducts.length > 1;

                        return (
                          <div key={name} className="space-y-2">
                            {hasMultiple ? (
                              <button
                                onClick={() => setExpandedGroups(prev => ({ ...prev, [name]: !prev[name] }))}
                                className="w-full flex items-center justify-between p-4 bg-white border border-gray-100 rounded-2xl hover:shadow-sm transition-all text-left group"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 group-hover:bg-blue-100 transition-colors">
                                    <Package size={20} />
                                  </div>
                                  <div>
                                    <h5 className="font-bold text-gray-900 text-sm">{name}</h5>
                                    <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                                      {groupProducts.length} phiên bản / kích thước
                                    </p>
                                  </div>
                                </div>
                                <ChevronDown 
                                  size={18} 
                                  className={cn("text-gray-400 transition-transform duration-300", isExpanded && "rotate-180")} 
                                />
                              </button>
                            ) : null}

                            <AnimatePresence initial={false}>
                              {(isExpanded || !hasMultiple) && (
                                <motion.div
                                  initial={hasMultiple ? { height: 0, opacity: 0 } : false}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className={cn("space-y-2 overflow-hidden", hasMultiple && "pl-4 border-l-2 border-blue-50 ml-5")}
                                >
                                  {groupProducts.map((product) => (
                                    <div key={product.id} className="group bg-white border border-gray-100 rounded-2xl p-4 hover:shadow-md transition-shadow relative">
                                      {editingProduct?.id === product.id ? (
                                        <div className="space-y-3">
                                          <input 
                                            type="text" 
                                            defaultValue={product.name}
                                            id={`edit-name-${product.id}`}
                                            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                            placeholder="Tên sản phẩm"
                                          />
                                          <div className="grid grid-cols-2 gap-2">
                                            <input 
                                              type="text" 
                                              defaultValue={product.size || ''}
                                              id={`edit-size-${product.id}`}
                                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                              placeholder="Kích thước"
                                            />
                                            <input 
                                              type="text" 
                                              defaultValue={product.thickness || ''}
                                              id={`edit-thickness-${product.id}`}
                                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                              placeholder="Độ dày"
                                            />
                                            <input 
                                              type="number" 
                                              defaultValue={product.price}
                                              id={`edit-price-${product.id}`}
                                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                              placeholder="Giá bán"
                                            />
                                            <input 
                                              type="text" 
                                              defaultValue={product.unit || ''}
                                              id={`edit-unit-${product.id}`}
                                              className="px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                              placeholder="Đơn vị"
                                            />
                                            <input 
                                              type="text" 
                                              defaultValue={product.category || ''}
                                              id={`edit-category-${product.id}`}
                                              className="col-span-2 px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500"
                                              placeholder="Danh mục"
                                            />
                                          </div>
                                          <textarea 
                                            defaultValue={product.attributes ? Object.entries(product.attributes).map(([k, v]) => `${k}: ${v}`).join('; ') : ''}
                                            id={`edit-attrs-${product.id}`}
                                            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm outline-none focus:border-blue-500 min-h-[60px]"
                                            placeholder="Thuộc tính khác (VD: Màu: Xanh; Chất liệu: Cao su)"
                                          />
                                          <div className="flex gap-2">
                                            <button
                                              onClick={() => {
                                                const name = (document.getElementById(`edit-name-${product.id}`) as HTMLInputElement).value;
                                                const price = parseInt((document.getElementById(`edit-price-${product.id}`) as HTMLInputElement).value);
                                                const size = (document.getElementById(`edit-size-${product.id}`) as HTMLInputElement).value;
                                                const thickness = (document.getElementById(`edit-thickness-${product.id}`) as HTMLInputElement).value;
                                                const unit = (document.getElementById(`edit-unit-${product.id}`) as HTMLInputElement).value;
                                                const category = (document.getElementById(`edit-category-${product.id}`) as HTMLInputElement).value;
                                                const attrsStr = (document.getElementById(`edit-attrs-${product.id}`) as HTMLTextAreaElement).value;
                                                
                                                const attrs: Record<string, string> = {};
                                                if (attrsStr) {
                                                  attrsStr.split(/[;,\n|]/).forEach(p => {
                                                    const [k, v] = p.split(':').map(s => s.trim());
                                                    if (k && v) attrs[k] = v;
                                                    else if (k) attrs[k] = 'Có';
                                                  });
                                                }

                                                handleUpdateProduct(product.id, { name, price, size, thickness, unit, category: category || guessCategory(name), attributes: attrs });
                                              }}
                                              className="flex-1 bg-blue-500 text-white text-xs font-bold py-2 rounded-lg hover:bg-blue-600"
                                            >
                                              Lưu
                                            </button>
                                            <button
                                              onClick={() => setEditingProduct(null)}
                                              className="flex-1 bg-gray-100 text-gray-600 text-xs font-bold py-2 rounded-lg hover:bg-gray-200"
                                            >
                                              Hủy
                                            </button>
                                          </div>
                                        </div>
                                      ) : (
                                        <>
                                          <div className="pr-16">
                                            <h5 className="font-bold text-gray-900 text-base flex items-center gap-2">
                                              {product.name}
                                              <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-bold rounded-full uppercase tracking-wider">
                                                {product.category || guessCategory(product.name)}
                                              </span>
                                            </h5>
                                            
                                            {(() => {
                                              const attrs = [
                                                product.size ? product.size.replace(/\*/g, 'x') : null,
                                                product.thickness,
                                                ...(product.attributes ? Object.entries(product.attributes).map(([k, v]) => {
                                                  if (v === 'Có') return k;
                                                  const keyStr = String(k).toUpperCase();
                                                  const valStr = v ? String(v) : '';
                                                  if (keyStr === 'KÍCH THƯỚC' || keyStr === 'DÀY' || keyStr === 'SIZE') {
                                                    return valStr.replace(/\*/g, 'x');
                                                  }
                                                  return valStr;
                                                }) : [])
                                              ].filter(Boolean);
                                              
                                              if (attrs.length === 0) return null;
                                              
                                              return (
                                                <p className="text-xs font-bold text-gray-500 mt-1 uppercase tracking-wide">
                                                  {attrs.join(' - ')}
                                                </p>
                                              );
                                            })()}

                                            <div className="flex items-baseline gap-2 mt-2">
                                              <span className="text-blue-600 font-black text-lg">
                                                {formatCurrency(product.price)}
                                              </span>
                                              {product.unit && <span className="text-gray-400 text-sm font-medium">/ {product.unit}</span>}
                                            </div>
                                            {isAdmin && product.wholesalePrice && (
                                              <p className="text-green-600 font-semibold text-xs mt-0.5">
                                                Giá sỉ: {formatCurrency(product.wholesalePrice)}
                                                {product.unit && <span className="text-gray-400 font-normal ml-1">/ {product.unit}</span>}
                                              </p>
                                            )}
                                            {product.description && (
                                              <p className="text-xs text-gray-500 mt-1 line-clamp-2">{product.description}</p>
                                            )}
                                          </div>
                                          {isAdmin && (
                                            <div className="absolute top-4 right-4 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                              <button
                                                onClick={() => setEditingProduct(product)}
                                                className="p-1.5 text-gray-400 hover:text-blue-500 bg-gray-50 hover:bg-blue-50 rounded-lg transition-colors"
                                              >
                                                <Edit3 size={16} />
                                              </button>
                                              <button
                                                onClick={() => handleDeleteProduct(product.id)}
                                                className="p-1.5 text-gray-400 hover:text-red-500 bg-gray-50 hover:bg-red-50 rounded-lg transition-colors"
                                              >
                                                <Trash2 size={16} />
                                              </button>
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  ))}
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-6 pt-32 pb-48 text-center text-sm flex flex-col items-center gap-6">
        <div onClick={handleLuckyCatClick} className="cursor-pointer transition-transform active:scale-90">
          <LuckyCat className="w-16 h-16 sm:w-24 sm:h-24" />
        </div>
        <p className="bg-clip-text text-transparent bg-gradient-to-r from-red-500 via-pink-500 via-blue-500 to-yellow-500 font-medium drop-shadow-sm">
          © 2026 Mận Quý • Powered by Dephia
        </p>
      </footer>

      {/* Lucky Message Overlay */}
      <AnimatePresence>
        {showLuckyMessage && (
          <motion.div
            initial={{ opacity: 0, scale: 0.5, y: 50 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.5, y: -50 }}
            className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none"
          >
            <div className="bg-white/90 backdrop-blur-xl border-4 border-red-500 px-8 py-6 rounded-[40px] shadow-[0_20px_50px_rgba(239,68,68,0.3)] flex flex-col items-center gap-4">
              <span className="text-4xl sm:text-6xl font-black text-red-600 tracking-tighter animate-bounce text-center">
                {luckyMessageText}
              </span>
              <div className="flex gap-2">
                {[...Array(5)].map((_, i) => (
                  <motion.span
                    key={i}
                    animate={{ 
                      y: [0, -20, 0],
                      rotate: [0, 10, -10, 0]
                    }}
                    transition={{ 
                      duration: 1, 
                      repeat: Infinity, 
                      delay: i * 0.1 
                    }}
                    className="text-2xl"
                  >
                    💰
                  </motion.span>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chatbot UI */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end">
        <AnimatePresence>
          {isChatOpen && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              transition={{ type: 'tween', duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
              className="bg-white/90 backdrop-blur-xl border border-white/60 shadow-2xl rounded-2xl w-[320px] sm:w-[380px] h-[450px] sm:h-[500px] mb-4 flex flex-col overflow-hidden will-change-transform"
            >
              {/* Chat Header */}
              <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-rose-50 to-orange-50 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-gradient-primary flex items-center justify-center text-white shadow-sm">
                    <Bot size={18} />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 text-sm">Trợ lý Mận Quý</h3>
                    <p className="text-xs text-gray-500">Luôn sẵn sàng hỗ trợ</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button 
                    onClick={clearChat}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                    title="Xóa nội dung trò chuyện"
                  >
                    <Trash2 size={18} />
                  </button>
                  <button 
                    onClick={() => setIsChatOpen(false)}
                    className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-white/50 rounded-full transition-colors"
                    title="Đóng chat"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Chat Messages */}
              <div id="chat-messages-container" className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/30">
                {chatMessages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center space-y-3 opacity-60">
                    <Bot size={40} className="text-gray-400" />
                    <p className="text-sm text-gray-500">Xin chào! Tôi có thể giúp gì cho sếp hôm nay?</p>
                  </div>
                ) : (
                  chatMessages.map((msg, idx) => (
                    <div key={idx} className={cn("flex gap-2 max-w-[85%]", msg.role === 'user' ? "ml-auto flex-row-reverse" : "")}>
                      <div className={cn(
                        "w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-1",
                        msg.role === 'user' ? "bg-gray-200 text-gray-600" : "bg-gradient-primary text-white"
                      )}>
                        {msg.role === 'user' ? <UserIcon size={12} /> : <Bot size={12} />}
                      </div>
                      <div className={cn(
                        "px-3 py-2 rounded-2xl text-[14px] leading-relaxed",
                        msg.role === 'user' 
                          ? "bg-gray-900 text-white rounded-tr-sm" 
                          : "bg-white border border-gray-100 shadow-sm text-gray-800 rounded-tl-sm prose prose-sm prose-p:my-1 prose-a:text-rose-500 max-w-full overflow-hidden"
                      )}>
                        {msg.role === 'user' ? (
                          msg.text
                        ) : (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                        )}
                      </div>
                    </div>
                  ))
                )}
                {isChatLoading && (
                  <div className="flex gap-2 max-w-[85%]">
                    <div className="w-6 h-6 rounded-full bg-gradient-primary text-white flex items-center justify-center shrink-0 mt-1">
                      <Bot size={12} />
                    </div>
                    <div className="px-4 py-3 rounded-2xl bg-white border border-gray-100 shadow-sm rounded-tl-sm flex items-center gap-1">
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Chat Input */}
              <div className="p-3 border-t border-gray-100 bg-white">
                <form 
                  onSubmit={handleSendMessage}
                  className="flex items-center gap-2 bg-gray-100/80 rounded-full pl-4 pr-1.5 py-1.5 border border-transparent focus-within:border-rose-200 focus-within:bg-white transition-all"
                >
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Nhập tin nhắn..."
                    className="flex-1 bg-transparent border-none outline-none text-[16px] sm:text-sm text-gray-800 placeholder:text-gray-400"
                    disabled={isChatLoading}
                  />
                  <button
                    type="submit"
                    disabled={!chatInput.trim() || isChatLoading}
                    className="w-8 h-8 rounded-full bg-gradient-primary text-white flex items-center justify-center shrink-0 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  >
                    <Send size={14} className="ml-0.5" />
                  </button>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-3">
          {user && (
            <button
              onClick={() => {
                const nextState = !showHistory;
                setShowHistory(nextState);
                if (nextState) setShowProducts(false);
              }}
              className={cn(
                "w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95 relative",
                showHistory ? "bg-gray-800" : "bg-red-500 shadow-[0_8px_16px_rgba(239,68,68,0.3)]"
              )}
              title={showHistory ? "Đóng Lịch Sử" : "Lịch Sử"}
            >
              {showHistory ? <X size={28} /> : <History size={28} />}
              {!showHistory && history.length > 0 && (
                <span className="absolute -top-1 -right-1 bg-white text-red-500 text-[10px] w-5 h-5 flex items-center justify-center rounded-full font-bold shadow-sm border border-red-100">
                  {history.length}
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => {
              const nextState = !showProducts;
              setShowProducts(nextState);
              if (nextState) setShowHistory(false);
            }}
            className={cn(
              "w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95",
              showProducts ? "bg-gray-800" : "bg-blue-600 shadow-[0_8px_16px_rgba(37,99,235,0.3)]"
            )}
            title={showProducts ? "Đóng kho hàng" : "Mở kho hàng"}
          >
            {showProducts ? <X size={28} /> : <Package size={28} />}
          </button>
          <button
            onClick={() => {
              if (showProducts) {
                document.getElementById('product-drawer-content')?.scrollTo({ top: 0, behavior: 'smooth' });
              } else if (showHistory) {
                document.getElementById('history-drawer-content')?.scrollTo({ top: 0, behavior: 'smooth' });
              } else if (isChatOpen) {
                document.getElementById('chat-messages-container')?.scrollTo({ top: 0, behavior: 'smooth' });
              } else {
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            }}
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/80 backdrop-blur-md border border-white/60 flex items-center justify-center text-gray-700 shadow-lg transition-transform hover:scale-105 active:scale-95"
            title="Cuộn về đầu trang"
          >
            <ArrowUp size={28} strokeWidth={1.5} />
          </button>
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={cn(
              "w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-white shadow-lg transition-transform hover:scale-105 active:scale-95",
              isChatOpen ? "bg-gray-800" : "bg-gradient-primary shadow-[0_8px_16px_rgba(244,63,94,0.3)]"
            )}
          >
            {isChatOpen ? <X size={28} /> : <MessageCircle size={28} />}
          </button>
        </div>
      </div>

    </div>
  );
}
