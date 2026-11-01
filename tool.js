
const fs = require('fs');
const path = require('path');
const { generateOpcodeMap, BytecodeBuilder, generateVmRuntimeCode } = require('./vm_compiler_core');

function compileEngine() {
    const opMap = generateOpcodeMap();
    const b = new BytecodeBuilder(opMap);

    // =========================================================================
    // HELPER MACROS
    // =========================================================================
    function c(val) { return b.addConst(val); }
    function pushC(val) { b.emit('CONST', c(val)); }
    function pushL(idx) { b.emit('GET_LOCAL', idx); }
    function popL(idx) { b.emit('SET_LOCAL', idx); }
    function pushA(idx) { b.emit('GET_ARG', idx); }
    function callM(name, argc) {
        b.emit('CALL_METHOD', c(name), argc);
    }
    function callVM(name, argc) {
        b.emit('CALL_VM', c(name), argc);
    }

    // =========================================================================
    // 1. normalizeTimeline(timelineStr)
    // =========================================================================
    b.registerFunction('normalizeTimeline');
    pushA(0);
    b.emit('DUP');
    b.emit('NOT');
    const jNormTl = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushC('');
    b.emit('RETURN');
    b.patchJump(jNormTl + 1, b.markLabel());
    pushA(0);
    pushC(/,/g);
    pushC('.');
    callM('replace', 2);
    pushC(/\s*-->\s*/g);
    pushC(' --> ');
    callM('replace', 2);
    callM('trim', 0);
    b.emit('RETURN');

    // =========================================================================
    // 2. cleanMarkdown(raw)
    // =========================================================================
    b.registerFunction('cleanMarkdown');
    pushA(0);
    b.emit('DUP');
    b.emit('NOT');
    const jCleanMd = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushC('');
    b.emit('RETURN');
    b.patchJump(jCleanMd + 1, b.markLabel());
    pushA(0);
    pushC(/<think>[\s\S]*?<\/think>/gi);
    pushC('');
    callM('replace', 2);
    pushC(/--&gt;/g);
    pushC('-->');
    callM('replace', 2);
    pushC(/-&gt;/g);
    pushC('->');
    callM('replace', 2);
    pushC(/&gt;/g);
    pushC('>');
    callM('replace', 2);
    pushC(/&lt;/g);
    pushC('<');
    callM('replace', 2);
    pushC(/```[a-zA-Z0-9_-]*\n?/g);
    pushC('');
    callM('replace', 2);
    pushC(/```/g);
    pushC('');
    callM('replace', 2);
    pushC(/<\/?(?:font|b|i|u|span|p|div|br)[^>]*>/gi);
    pushC('');
    callM('replace', 2);
    b.emit('RETURN');

    // =========================================================================
    // 3. normalizeText(text)
    // =========================================================================
    b.registerFunction('normalizeText');
    pushA(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jNormTxt = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC('');
    const jNormTxtEnd = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jNormTxt + 1, b.markLabel());
    b.patchJump(jNormTxtEnd + 1, b.markLabel());
    pushC(/\r\n/g);
    pushC('\n');
    callM('replace', 2);
    pushC(/\r/g);
    pushC('\n');
    callM('replace', 2);
    callM('trim', 0);
    b.emit('RETURN');

    // =========================================================================
    // 4. containsChinese(text)
    // =========================================================================
    b.registerFunction('containsChinese');
    pushC(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/);
    pushA(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jCjk = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC('');
    b.patchJump(jCjk + 1, b.markLabel());
    callM('test', 1);
    b.emit('RETURN');

    // =========================================================================
    // 5. countChinese(text)
    // =========================================================================
    b.registerFunction('countChinese');
    pushA(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jCnt = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC('');
    b.patchJump(jCnt + 1, b.markLabel());
    pushC(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
    callM('match', 1);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jCntMatch = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushC('length');
    b.emit('GET_PROP');
    b.emit('RETURN');
    b.patchJump(jCntMatch + 1, b.markLabel());
    b.emit('POP');
    pushC(0);
    b.emit('RETURN');

    // =========================================================================
    // 6. isTranslationValid(original, translated)
    // =========================================================================
    b.registerFunction('isTranslationValid');
    // local 0 = origClean
    pushA(0);
    callVM('normalizeText', 1);
    popL(0);

    // local 1 = transClean
    pushA(1);
    callVM('normalizeText', 1);
    popL(1);

    // if (!transClean) return { valid: false, reason: 'Bản dịch rỗng' }
    pushL(1);
    b.emit('IS_TRUTHY');
    const jTransNotEmpty = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Bản dịch rỗng');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');

    b.patchJump(jTransNotEmpty + 1, b.markLabel());

    // local 2 = origHasChinese = containsChinese(origClean)
    pushL(0);
    callVM('containsChinese', 1);
    popL(2);

    // if (transClean === origClean)
    pushL(1);
    pushL(0);
    b.emit('EQ');
    const jNotSameText = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // if (origHasChinese) return { valid: false, reason: 'Chưa dịch (nguyên văn tiếng Trung)' }
    pushL(2);
    const jOrigHasNoCjk = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Chưa dịch (nguyên văn tiếng Trung)');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jOrigHasNoCjk + 1, b.markLabel());
    // else return { valid: true, reason: 'OK' }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(true);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('OK');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');

    b.patchJump(jNotSameText + 1, b.markLabel());

    // if (origHasChinese && containsChinese(transClean))
    pushL(2);
    const jSkipCjkCheck = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(1);
    callVM('containsChinese', 1);
    const jTransHasNoCjk = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Còn sót ký tự tiếng Trung');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jTransHasNoCjk + 1, b.markLabel());
    b.patchJump(jSkipCjkCheck + 1, b.markLabel());

    // return { valid: true, reason: 'OK' }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(true);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('OK');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');

    // =========================================================================
    // 7. calculateBatches(items, mode, batchSize)
    // =========================================================================
    b.registerFunction('calculateBatches');
    // args: 0: items, 1: mode, 2: batchSize
    // local 0 = items, local 1 = total, local 2 = effectiveSize, local 3 = totalBatches, local 4 = batches arr, local 5 = i
    pushA(0);
    popL(0);
    pushL(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jCalcHasItems = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC(0);
    const jCalcHasItemsEnd = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jCalcHasItems + 1, b.markLabel());
    pushC('length');
    b.emit('GET_PROP');
    b.patchJump(jCalcHasItemsEnd + 1, b.markLabel());
    popL(1); // total

    pushA(1);
    pushC('all');
    b.emit('EQ');
    const jCalcNotAll = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(1); // total
    const jCalcSizeEnd = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jCalcNotAll + 1, b.markLabel());
    pushA(2);
    pushC(10);
    b.emit('GET_GLOBAL', c('parseInt'));
    b.emit('CALL_FUNC', 2);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jParsedBatchValid = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC(100);
    b.patchJump(jParsedBatchValid + 1, b.markLabel());
    b.patchJump(jCalcSizeEnd + 1, b.markLabel());
    popL(2); // effectiveSize

    pushL(2);
    pushC(1);
    b.emit('LT');
    const jSizeGte1 = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushC(1);
    popL(2);
    b.patchJump(jSizeGte1 + 1, b.markLabel());

    // totalBatches = Math.ceil(total / effectiveSize)
    b.emit('GET_GLOBAL', c('Math'));
    pushL(1);
    pushL(2);
    b.emit('DIV');
    callM('ceil', 1);
    popL(3); // totalBatches

    // batches = []
    b.emit('NEW_ARR', 0);
    popL(4); // batches

    // for (let i = 0; i < totalBatches; i++)
    pushC(0);
    popL(5); // i = 0

    const loopBatchStart = b.markLabel();
    pushL(5);
    pushL(3);
    b.emit('LT');
    const loopBatchExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // start = i * effectiveSize
    pushL(5);
    pushL(2);
    b.emit('MUL');
    popL(6); // start

    // end = Math.min(start + effectiveSize, total)
    b.emit('GET_GLOBAL', c('Math'));
    pushL(6);
    pushL(2);
    b.emit('ADD');
    pushL(1);
    callM('min', 2);
    popL(7); // end

    // batchItem = { batchIndex: i + 1, totalBatches, items: items.slice(start, end) }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushL(5);
    pushC(1);
    b.emit('ADD');
    pushC('batchIndex');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(3);
    pushC('totalBatches');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(0);
    pushL(6);
    pushL(7);
    callM('slice', 2);
    pushC('items');
    b.emit('SET_PROP');

    pushL(4);
    b.emit('ARRAY_PUSH');

    // i++
    pushL(5);
    pushC(1);
    b.emit('ADD');
    popL(5);
    b.emit('JUMP', loopBatchStart);

    b.patchJump(loopBatchExit + 1, b.markLabel());

    // return { totalBatches, batches, totalItems: total }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushL(3);
    pushC('totalBatches');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(4);
    pushC('batches');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(1);
    pushC('totalItems');
    b.emit('SET_PROP');
    b.emit('RETURN');

    // =========================================================================
    // 8. buildBatchPrompt(activePrompt, batchItems)
    // =========================================================================
    b.registerFunction('buildBatchPrompt');
    // args: 0: activePrompt, 1: batchItems
    // lines = []
    b.emit('NEW_ARR', 0);
    popL(0); // lines
    pushC(0);
    popL(1); // i = 0

    const loopBldStart = b.markLabel();
    pushA(1);
    pushC('length');
    b.emit('GET_PROP');
    pushL(1);
    b.emit('GT');
    const loopBldExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(1);
    pushL(1);
    b.emit('GET_PROP');
    popL(2); // it

    // line = '#' + it.id + ' ' + (it.original || '').replace(/\n/g, ' ')
    pushC('#');
    pushL(2);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' ');
    b.emit('ADD');
    pushL(2);
    pushC('original');
    b.emit('GET_PROP');
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jOrigValid = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC('');
    b.patchJump(jOrigValid + 1, b.markLabel());
    pushC(/\n/g);
    pushC(' ');
    callM('replace', 2);
    b.emit('ADD');

    pushL(0);
    b.emit('ARRAY_PUSH');

    // i++
    pushL(1);
    pushC(1);
    b.emit('ADD');
    popL(1);
    b.emit('JUMP', loopBldStart);

    b.patchJump(loopBldExit + 1, b.markLabel());

    // return activePrompt + '\n\n' + lines.join('\n')
    pushA(0);
    pushC('\n\n');
    b.emit('ADD');
    pushL(0);
    pushC('\n');
    callM('join', 1);
    b.emit('ADD');
    b.emit('RETURN');

    // =========================================================================
    // 9. buildRetryPrompt(missingItems)
    // =========================================================================
    b.registerFunction('buildRetryPrompt');
    b.emit('NEW_ARR', 0);
    popL(0); // lines
    pushC(0);
    popL(1); // i = 0

    const loopRtrStart = b.markLabel();
    pushA(0);
    pushC('length');
    b.emit('GET_PROP');
    pushL(1);
    b.emit('GT');
    const loopRtrExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(1);
    b.emit('GET_PROP');
    popL(2); // it

    pushC('#');
    pushL(2);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' ');
    b.emit('ADD');
    pushL(2);
    pushC('original');
    b.emit('GET_PROP');
    pushC(/\n/g);
    pushC(' ');
    callM('replace', 2);
    b.emit('ADD');

    pushL(0);
    b.emit('ARRAY_PUSH');

    pushL(1);
    pushC(1);
    b.emit('ADD');
    popL(1);
    b.emit('JUMP', loopRtrStart);

    b.patchJump(loopRtrExit + 1, b.markLabel());

    pushC('Dưới đây là các câu còn thiếu hoặc cần dịch lại từ lượt trước. Hãy dịch chuẩn xác sang tiếng Việt theo đúng ngữ cảnh đã dịch.\n\nYÊU CẦU BẮT BUỘC:\n1. CHỈ trả về đúng định dạng chuẩn: #ID <Bản dịch tiếng Việt>\n2. Bắt buộc giữ nguyên đúng số #ID của từng câu theo danh sách dưới đây, KHÔNG đánh lại số thứ tự từ 1.\n3. TUYỆT ĐỐI KHÔNG giải thích, không thêm lời chào, không dùng khối mã markdown (```).\n\n');
    pushL(0);
    pushC('\n');
    callM('join', 1);
    b.emit('ADD');
    b.emit('RETURN');

    // =========================================================================
    // 10. buildRecoveryPrompt(activePrompt, contextItem, missingItems)
    // =========================================================================
    b.registerFunction('buildRecoveryPrompt');
    // args: 0: activePrompt, 1: contextItem, 2: missingItems
    pushA(2);
    pushC(0);
    b.emit('GET_PROP');
    pushC('id');
    b.emit('GET_PROP');
    popL(0); // firstMissingId

    pushC('');
    popL(1); // contextBlock = ''

    pushA(1);
    b.emit('IS_TRUTHY');
    const jNoCtx = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushC('--- [DÒNG NGỮ CẢNH THAM CHIẾU - BẮT BUỘC ĐỌC KỸ] ---\nDưới đây là câu liền trước đã dịch thành công, cung cấp DUY NHẤT để bạn nắm bắt mạch nội dung:\n#');
    pushA(1);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' [Gốc]: ');
    b.emit('ADD');
    pushA(1);
    pushC('original');
    b.emit('GET_PROP');
    callVM('normalizeText', 1);
    b.emit('ADD');
    pushC('\n#');
    b.emit('ADD');
    pushA(1);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' [Đã dịch]: ');
    b.emit('ADD');
    pushA(1);
    pushC('translated');
    b.emit('GET_PROP');
    callVM('normalizeText', 1);
    b.emit('ADD');
    pushC('\n\nQUY TẮC BẮT BUỘC VỀ DÒNG NGỮ CẢNH:\n- Đây là dòng ngữ cảnh để AI hiểu mạch nội dung.\n- AI TUYỆT ĐỐI KHÔNG ĐƯỢC dịch lại câu #');
    b.emit('ADD');
    pushA(1);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC('.\n- AI TUYỆT ĐỐI KHÔNG ĐƯỢC đưa câu #');
    b.emit('ADD');
    pushA(1);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' vào kết quả trả về.\n- Bắt đầu dịch chính xác từ câu #');
    b.emit('ADD');
    pushL(0);
    b.emit('ADD');
    pushC(' (đoạn bị thiếu đầu tiên).\n- Giữ nguyên số thứ tự #');
    b.emit('ADD');
    pushL(0);
    b.emit('ADD');
    pushC(' trở đi và định dạng chuẩn.\n---------------------------------------------------\n\n');
    b.emit('ADD');
    popL(1); // contextBlock
    b.patchJump(jNoCtx + 1, b.markLabel());

    b.emit('NEW_ARR', 0);
    popL(2); // missingLines
    pushC(0);
    popL(3); // i = 0

    const loopRecStart = b.markLabel();
    pushA(2);
    pushC('length');
    b.emit('GET_PROP');
    pushL(3);
    b.emit('GT');
    const loopRecExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(2);
    pushL(3);
    b.emit('GET_PROP');
    popL(4); // it

    pushC('#');
    pushL(4);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' ');
    b.emit('ADD');
    pushL(4);
    pushC('original');
    b.emit('GET_PROP');
    b.emit('ADD');

    pushL(2);
    b.emit('ARRAY_PUSH');

    pushL(3);
    pushC(1);
    b.emit('ADD');
    popL(3);
    b.emit('JUMP', loopRecStart);

    b.patchJump(loopRecExit + 1, b.markLabel());

    pushA(0);
    pushC('\n\n');
    b.emit('ADD');
    pushL(1);
    b.emit('ADD');
    pushC('DANH SÁCH CÁC CÂU CẦN DỊCH (Bắt đầu chính xác từ #');
    b.emit('ADD');
    pushL(0);
    b.emit('ADD');
    pushC('):\n');
    b.emit('ADD');
    pushL(2);
    pushC('\n');
    callM('join', 1);
    b.emit('ADD');
    b.emit('RETURN');

    // =========================================================================
    // 11. validateTranslationResults(expectedItems, parsedResultMap)
    // =========================================================================
    b.registerFunction('validateTranslationResults');
    // args: 0: expectedItems, 1: parsedResultMap
    b.emit('NEW_ARR', 0);
    popL(0); // completed
    b.emit('NEW_ARR', 0);
    popL(1); // missing
    b.emit('NEW_ARR', 0);
    popL(2); // invalid
    pushC(0);
    popL(3); // i = 0

    const loopValResStart = b.markLabel();
    pushA(0);
    pushC('length');
    b.emit('GET_PROP');
    pushL(3);
    b.emit('GT');
    const loopValResExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(3);
    b.emit('GET_PROP');
    popL(4); // it

    // cand = parsedResultMap ? parsedResultMap[it.id] : undefined
    pushA(1);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jValResHasMap = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC(undefined);
    const jValResCandEnd = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jValResHasMap + 1, b.markLabel());
    pushL(4);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('GET_PROP');
    b.patchJump(jValResCandEnd + 1, b.markLabel());
    popL(5); // cand

    pushL(5);
    b.emit('IS_TRUTHY');
    const jValResNoCand = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // val = isTranslationValid(it.original, cand)
    pushL(4);
    pushC('original');
    b.emit('GET_PROP');
    pushL(5);
    callVM('isTranslationValid', 2);
    popL(6); // val

    pushL(6);
    pushC('valid');
    b.emit('GET_PROP');
    const jValResNotOk = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // completed
    pushL(4);
    pushL(5);
    pushC('translated');
    b.emit('SET_PROP');
    pushL(4);
    pushC('completed');
    pushC('status');
    b.emit('SET_PROP');
    pushL(4);
    pushC(null);
    pushC('errorReason');
    b.emit('SET_PROP');
    pushL(4);
    pushL(0);
    b.emit('ARRAY_PUSH');
    const jValResNext = b.markLabel();
    b.emit('JUMP', 0);

    b.patchJump(jValResNotOk + 1, b.markLabel());
    // invalid
    pushL(4);
    pushC('invalid');
    pushC('status');
    b.emit('SET_PROP');
    pushL(4);
    pushL(6);
    pushC('reason');
    b.emit('GET_PROP');
    pushC('errorReason');
    b.emit('SET_PROP');
    pushL(4);
    pushL(2);
    b.emit('ARRAY_PUSH');
    b.emit('JUMP', jValResNext);

    b.patchJump(jValResNoCand + 1, b.markLabel());
    // missing
    pushL(4);
    pushC('status');
    b.emit('GET_PROP');
    pushC('completed');
    b.emit('NEQ');
    const jValResAlreadyDone = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(4);
    pushC('missing');
    pushC('status');
    b.emit('SET_PROP');
    pushL(4);
    pushL(1);
    b.emit('ARRAY_PUSH');
    b.patchJump(jValResAlreadyDone + 1, b.markLabel());

    b.patchJump(jValResNext + 1, b.markLabel());

    // i++
    pushL(3);
    pushC(1);
    b.emit('ADD');
    popL(3);
    b.emit('JUMP', loopValResStart);

    b.patchJump(loopValResExit + 1, b.markLabel());

    // return { completed, missing, invalid }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushL(0);
    pushC('completed');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(1);
    pushC('missing');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(2);
    pushC('invalid');
    b.emit('SET_PROP');
    b.emit('RETURN');

    // =========================================================================
    // 12. validateFinalExport(items)
    // =========================================================================
    b.registerFunction('validateFinalExport');
    // args: 0: items
    pushA(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jExpHasArr = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC(0);
    const jExpLenEnd = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jExpHasArr + 1, b.markLabel());
    pushC('length');
    b.emit('GET_PROP');
    b.patchJump(jExpLenEnd + 1, b.markLabel());
    popL(0); // length

    pushL(0);
    pushC(0);
    b.emit('EQ');
    const jExpNotEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Danh sách phụ đề rỗng.');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jExpNotEmpty + 1, b.markLabel());

    // uncompleted = items.filter(it => !it.translated || it.status !== 'completed')
    b.emit('NEW_ARR', 0);
    popL(1); // uncompleted
    pushC(0);
    popL(2); // i = 0

    const loopExpChkStart = b.markLabel();
    pushL(0);
    pushL(2);
    b.emit('GT');
    const loopExpChkExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(2);
    b.emit('GET_PROP');
    popL(3); // it

    pushL(3);
    pushC('translated');
    b.emit('GET_PROP');
    b.emit('NOT');
    b.emit('DUP');
    const jExpHasTrans = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushL(3);
    pushC('status');
    b.emit('GET_PROP');
    pushC('completed');
    b.emit('NEQ');
    b.patchJump(jExpHasTrans + 1, b.markLabel());

    const jExpIsDone = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(3);
    pushL(1);
    b.emit('ARRAY_PUSH');
    b.patchJump(jExpIsDone + 1, b.markLabel());

    pushL(2);
    pushC(1);
    b.emit('ADD');
    popL(2);
    b.emit('JUMP', loopExpChkStart);

    b.patchJump(loopExpChkExit + 1, b.markLabel());

    pushL(1);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jExpAllDone = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // uncompleted found
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Còn ');
    pushL(1);
    pushC('length');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' câu chưa hoàn thành dịch.');
    b.emit('ADD');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jExpAllDone + 1, b.markLabel());

    // validate each item translation quality
    pushC(0);
    popL(2); // i = 0

    const loopQualStart = b.markLabel();
    pushL(0);
    pushL(2);
    b.emit('GT');
    const loopQualExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(2);
    b.emit('GET_PROP');
    popL(3); // it

    pushL(3);
    pushC('original');
    b.emit('GET_PROP');
    pushL(3);
    pushC('translated');
    b.emit('GET_PROP');
    callVM('isTranslationValid', 2);
    popL(4); // check

    pushL(4);
    pushC('valid');
    b.emit('GET_PROP');
    const jQualOk = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(false);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('Câu #');
    pushL(3);
    pushC('id');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC(' không đạt chuẩn: ');
    b.emit('ADD');
    pushL(4);
    pushC('reason');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC('reason');
    b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jQualOk + 1, b.markLabel());

    pushL(2);
    pushC(1);
    b.emit('ADD');
    popL(2);
    b.emit('JUMP', loopQualStart);

    b.patchJump(loopQualExit + 1, b.markLabel());

    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushC(true);
    pushC('valid');
    b.emit('SET_PROP');
    b.emit('RETURN');

    // =========================================================================
    // 13. buildCompleteSrtContent(items)
    // =========================================================================
    b.registerFunction('buildCompleteSrtContent');
    pushA(0);
    callVM('validateFinalExport', 1);
    popL(0); // check

    pushL(0);
    pushC('valid');
    b.emit('GET_PROP');
    const jSrtExpOk = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    pushC('Kiểm tra xuất file thất bại: ');
    pushL(0);
    pushC('reason');
    b.emit('GET_PROP');
    b.emit('ADD');
    b.emit('THROW');
    b.patchJump(jSrtExpOk + 1, b.markLabel());

    b.emit('NEW_ARR', 0);
    popL(1); // blocks
    pushC(0);
    popL(2); // i = 0

    const loopSrtStart = b.markLabel();
    pushA(0);
    pushC('length');
    b.emit('GET_PROP');
    pushL(2);
    b.emit('GT');
    const loopSrtExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(2);
    b.emit('GET_PROP');
    popL(3); // it

    pushL(2);
    pushC(1);
    b.emit('ADD');
    pushC('\n');
    b.emit('ADD');
    pushL(3);
    pushC('timeline');
    b.emit('GET_PROP');
    b.emit('ADD');
    pushC('\n');
    b.emit('ADD');
    pushL(3);
    pushC('translated');
    b.emit('GET_PROP');
    b.emit('ADD');

    pushL(1);
    b.emit('ARRAY_PUSH');

    pushL(2);
    pushC(1);
    b.emit('ADD');
    popL(2);
    b.emit('JUMP', loopSrtStart);

    b.patchJump(loopSrtExit + 1, b.markLabel());

    pushL(1);
    pushC('\n\n');
    callM('join', 1);
    pushC('\n');
    b.emit('ADD');
    b.emit('RETURN');

    // =========================================================================
    // 14. parseSrtContent(content)
    // =========================================================================
    b.registerFunction('parseSrtContent');
    // Delegate to VM sub-routine or native bridge within VM
    // We parse UTF-8 BOM, split blocks, parse timeline and lines
    pushA(0);
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jPContentOk = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    b.emit('NEW_ARR', 0);
    b.emit('RETURN');
    b.patchJump(jPContentOk + 1, b.markLabel());

    pushA(0);
    pushC(/^\uFEFF/);
    pushC('');
    callM('replace', 2);
    pushC(/\r\n/g);
    pushC('\n');
    callM('replace', 2);
    pushC(/\r/g);
    pushC('\n');
    callM('replace', 2);
    callM('trim', 0);
    popL(0); // cleaned

    pushL(0);
    pushC(/\n\s*\n/);
    callM('split', 1);
    popL(1); // blocks

    b.emit('NEW_ARR', 0);
    popL(2); // items = []
    pushC(1);
    popL(3); // autoId = 1
    pushC(0);
    popL(4); // i = 0

    const loopBlkStart = b.markLabel();
    pushL(1);
    pushC('length');
    b.emit('GET_PROP');
    pushL(4);
    b.emit('GT');
    const loopBlkExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(1);
    pushL(4);
    b.emit('GET_PROP');
    pushC('\n');
    callM('split', 1);
    popL(5); // rawLines

    b.emit('NEW_ARR', 0);
    popL(6); // lines = []
    pushC(0);
    popL(7); // lIdx = 0

    const loopTrimStart = b.markLabel();
    pushL(5);
    pushC('length');
    b.emit('GET_PROP');
    pushL(7);
    b.emit('GT');
    const loopTrimExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(5);
    pushL(7);
    b.emit('GET_PROP');
    callM('trim', 0);
    popL(8); // trimmed
    pushL(8);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jTrimEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(8);
    pushL(6);
    b.emit('ARRAY_PUSH');
    b.patchJump(jTrimEmpty + 1, b.markLabel());

    pushL(7);
    pushC(1);
    b.emit('ADD');
    popL(7);
    b.emit('JUMP', loopTrimStart);

    b.patchJump(loopTrimExit + 1, b.markLabel());

    pushL(6);
    pushC('length');
    b.emit('GET_PROP');
    pushC(2);
    b.emit('LT');
    const jBlkValid = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // skip block
    const jNextBlk = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jBlkValid + 1, b.markLabel());

    // find timeIdx
    pushC(-1);
    popL(9); // timeIdx = -1
    pushC(0);
    popL(10); // j = 0

    const loopFindTimeStart = b.markLabel();
    pushL(6);
    pushC('length');
    b.emit('GET_PROP');
    pushL(10);
    b.emit('GT');
    const loopFindTimeExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(6);
    pushL(10);
    b.emit('GET_PROP');
    pushC('-->');
    callM('includes', 1);
    const jHasArrow = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(10);
    popL(9);
    b.emit('JUMP', loopFindTimeExit);
    b.patchJump(jHasArrow + 1, b.markLabel());

    pushL(10);
    pushC(1);
    b.emit('ADD');
    popL(10);
    b.emit('JUMP', loopFindTimeStart);

    b.patchJump(loopFindTimeExit + 1, b.markLabel());

    pushL(9);
    pushC(-1);
    b.emit('EQ');
    const jTimeFound = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('JUMP', jNextBlk);
    b.patchJump(jTimeFound + 1, b.markLabel());

    // originalIndex = autoId
    pushL(3);
    popL(11); // originalIndex
    pushL(9);
    pushC(0);
    b.emit('GT');
    const jNoIdxAbove = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(6);
    pushC(0);
    b.emit('GET_PROP');
    pushC(10);
    b.emit('GET_GLOBAL', c('parseInt'));
    b.emit('CALL_FUNC', 2);
    popL(12);
    pushL(12);
    b.emit('GET_GLOBAL', c('isNaN'));
    b.emit('CALL_FUNC', 1);
    const jIdxNan = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    pushL(12);
    popL(11);
    b.patchJump(jIdxNan + 1, b.markLabel());
    b.patchJump(jNoIdxAbove + 1, b.markLabel());

    // timeline = lines[timeIdx]
    pushL(6);
    pushL(9);
    b.emit('GET_PROP');
    popL(13); // timeline

    // parts = timeline.split('-->')
    pushL(13);
    pushC('-->');
    callM('split', 1);
    popL(14); // parts

    pushL(14);
    pushC(0);
    b.emit('GET_PROP');
    callM('trim', 0);
    popL(15); // startTime

    pushL(14);
    pushC(1);
    b.emit('GET_PROP');
    callM('trim', 0);
    popL(16); // endTime

    pushL(13);
    callVM('normalizeTimeline', 1);
    popL(17); // normTimeline

    // textLines = lines.slice(timeIdx + 1)
    pushL(6);
    pushL(9);
    pushC(1);
    b.emit('ADD');
    callM('slice', 1);
    pushC(' ');
    callM('join', 1);
    callM('trim', 0);
    popL(18); // originalText

    pushL(18);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('EQ');
    const jOrigTxtNotEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('JUMP', jNextBlk);
    b.patchJump(jOrigTxtNotEmpty + 1, b.markLabel());

    // push item
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushL(3);
    pushC('id');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(11);
    pushC('originalIndex');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(13);
    pushC('timeline');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(17);
    pushC('normalizedTimeline');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(15);
    pushC('startTime');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(16);
    pushC('endTime');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushL(18);
    pushC('original');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC(null);
    pushC('translated');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC('pending');
    pushC('status');
    b.emit('SET_PROP');
    b.emit('DUP');
    pushC(null);
    pushC('errorReason');
    b.emit('SET_PROP');

    pushL(2);
    b.emit('ARRAY_PUSH');

    // autoId++
    pushL(3);
    pushC(1);
    b.emit('ADD');
    popL(3);

    b.patchJump(jNextBlk + 1, b.markLabel());

    // i++
    pushL(4);
    pushC(1);
    b.emit('ADD');
    popL(4);
    b.emit('JUMP', loopBlkStart);

    b.patchJump(loopBlkExit + 1, b.markLabel());

    pushL(2);
    b.emit('RETURN');

    // =========================================================================
    // 15. parseAiResponse(rawText, expectedInput)
    // =========================================================================
    b.registerFunction('parseAiResponse');
    // args: 0: rawText, 1: expectedInput
    pushA(0);
    callVM('cleanMarkdown', 1);
    popL(0); // cleaned

    b.emit('NEW_OBJ');
    popL(1); // resultMap = {}

    pushL(0);
    callM('trim', 0);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jAiHasTxt = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    pushL(1);
    b.emit('RETURN');
    b.patchJump(jAiHasTxt + 1, b.markLabel());

    // expectedIdSet = new Set(), timelineToItemMap = new Map(), idToItemMap = new Map()
    b.emit('NEW_SET');
    popL(2); // expectedIdSet
    b.emit('NEW_MAP');
    popL(3); // timelineToItemMap
    b.emit('NEW_MAP');
    popL(4); // idToItemMap

    b.emit('GET_GLOBAL', c('Array'));
    pushA(1);
    callM('isArray', 1);
    const jExpectedIsArr = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // populate expectedIdSet, timelineToItemMap, idToItemMap from array
    pushC(0);
    popL(5); // i = 0
    const loopExpMapStart = b.markLabel();
    pushA(1);
    pushC('length');
    b.emit('GET_PROP');
    pushL(5);
    b.emit('GT');
    const loopExpMapExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(1);
    pushL(5);
    b.emit('GET_PROP');
    popL(6); // it

    pushL(6);
    pushC('id');
    b.emit('GET_PROP');
    pushL(2);
    b.emit('SET_ADD');

    pushL(6);
    pushL(6);
    pushC('id');
    b.emit('GET_PROP');
    pushL(4);
    b.emit('MAP_SET');

    pushL(6);
    pushC('normalizedTimeline');
    b.emit('GET_PROP');
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jNormTlPresent = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushL(6);
    pushC('timeline');
    b.emit('GET_PROP');
    callVM('normalizeTimeline', 1);
    b.patchJump(jNormTlPresent + 1, b.markLabel());
    popL(7); // norm

    pushL(7);
    b.emit('IS_TRUTHY');
    const jNormEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(6);
    pushL(7);
    pushL(3);
    b.emit('MAP_SET');
    b.patchJump(jNormEmpty + 1, b.markLabel());

    pushL(5);
    pushC(1);
    b.emit('ADD');
    popL(5);
    b.emit('JUMP', loopExpMapStart);

    b.patchJump(loopExpMapExit + 1, b.markLabel());

    const jExpSetupDone = b.markLabel();
    b.emit('JUMP', 0);

    b.patchJump(jExpectedIsArr + 1, b.markLabel());
    // else if expectedInput instanceof Set
    pushA(1);
    b.emit('GET_GLOBAL', c('Set'));
    b.emit('INSTANCEOF');
    const jExpectedIsSet = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushA(1);
    popL(2);
    b.patchJump(jExpectedIsSet + 1, b.markLabel());

    b.patchJump(jExpSetupDone + 1, b.markLabel());

    // Parse #ID lines
    pushL(0);
    pushC('\n');
    callM('split', 1);
    popL(8); // lines

    pushC(/^#\s*(\d+)[\s:：.\-]*(.*)$/);
    popL(9); // headerRegex

    pushC(null);
    popL(10); // currentId = null
    b.emit('NEW_ARR', 0);
    popL(11); // currentLines = []

    // Helper macro to flush currentId into resultMap
    function emitFlush() {
        pushL(10);
        pushC(null);
        b.emit('NEQ');
        const jFlushHasId = b.markLabel();
        b.emit('JUMP_IF_FALSE', 0);

        pushL(10);
        pushL(2);
        b.emit('SET_HAS');
        const jFlushInExp = b.markLabel();
        b.emit('JUMP_IF_FALSE', 0);

        pushL(11);
        pushC(' ');
        callM('join', 1);
        callM('trim', 0);
        popL(12); // text

        pushL(12);
        pushC(/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*(?:-->|->)\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g);
        pushC('');
        callM('replace', 2);
        callM('trim', 0);
        popL(12);

        pushL(12);
        pushC('length');
        b.emit('GET_PROP');
        pushC(0);
        b.emit('GT');
        const jFlushTextEmpty = b.markLabel();
        b.emit('JUMP_IF_FALSE', 0);

        pushL(1);
        pushL(12);
        pushL(10);
        b.emit('SET_PROP'); // resultMap[currentId] = text

        b.patchJump(jFlushTextEmpty + 1, b.markLabel());
        b.patchJump(jFlushInExp + 1, b.markLabel());
        b.patchJump(jFlushHasId + 1, b.markLabel());

        pushC(null);
        popL(10);
        b.emit('NEW_ARR', 0);
        popL(11);
    }

    pushC(0);
    popL(13); // lineIdx = 0

    const loopAiLinesStart = b.markLabel();
    pushL(8);
    pushC('length');
    b.emit('GET_PROP');
    pushL(13);
    b.emit('GT');
    const loopAiLinesExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(8);
    pushL(13);
    b.emit('GET_PROP');
    callM('trim', 0);
    popL(14); // trimmed

    pushL(14);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('EQ');
    const jLineNotEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // skip empty line
    const jNextAiLine = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jLineNotEmpty + 1, b.markLabel());

    pushL(14);
    pushL(9);
    callM('match', 1);
    popL(15); // headerMatch

    pushL(15);
    b.emit('IS_TRUTHY');
    const jIsHeader = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // isHeader -> flush current
    emitFlush();

    pushL(15);
    pushC(1);
    b.emit('GET_PROP');
    pushC(10);
    b.emit('GET_GLOBAL', c('parseInt'));
    b.emit('CALL_FUNC', 2);
    popL(16); // parsedId

    pushL(16);
    pushL(2);
    b.emit('SET_HAS');
    const jParsedInExp = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(16);
    popL(10); // currentId = parsedId

    pushL(15);
    pushC(2);
    b.emit('GET_PROP');
    b.emit('DUP');
    b.emit('IS_TRUTHY');
    const jInlineHasVal = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.emit('POP');
    pushC('');
    b.patchJump(jInlineHasVal + 1, b.markLabel());
    callM('trim', 0);
    popL(17); // inlineText

    pushL(17);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jInlineEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(17);
    pushL(11);
    b.emit('ARRAY_PUSH');
    b.patchJump(jInlineEmpty + 1, b.markLabel());

    b.patchJump(jParsedInExp + 1, b.markLabel());
    b.emit('JUMP', jNextAiLine);

    b.patchJump(jIsHeader + 1, b.markLabel());

    // Else if currentId !== null -> multi-line text accumulation
    pushL(10);
    pushC(null);
    b.emit('NEQ');
    const jHasCurId = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(14);
    pushC('```');
    callM('startsWith', 1);
    const jFence = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    pushL(14);
    pushL(11);
    b.emit('ARRAY_PUSH');
    b.patchJump(jFence + 1, b.markLabel());

    b.patchJump(jHasCurId + 1, b.markLabel());

    b.patchJump(jNextAiLine + 1, b.markLabel());

    pushL(13);
    pushC(1);
    b.emit('ADD');
    popL(13);
    b.emit('JUMP', loopAiLinesStart);

    b.patchJump(loopAiLinesExit + 1, b.markLabel());

    // Final flush
    emitFlush();

    // 2. Fallback: SRT block format with TIMELINE PRIORITY MATCHING
    pushL(0);
    pushC('-->');
    callM('includes', 1);
    const jHasSrtBlocks = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(0);
    pushC(/\n\s*\n/);
    callM('split', 1);
    popL(18); // srtBlocks
    pushC(0);
    popL(19); // bIdx = 0

    const loopSrtBlkStart = b.markLabel();
    pushL(18);
    pushC('length');
    b.emit('GET_PROP');
    pushL(19);
    b.emit('GT');
    const loopSrtBlkExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(18);
    pushL(19);
    b.emit('GET_PROP');
    pushC('\n');
    callM('split', 1);
    popL(20); // rawBlockLines

    b.emit('NEW_ARR', 0);
    popL(21); // bLines = []
    pushC(0);
    popL(22); // lk = 0

    const loopBLinesStart = b.markLabel();
    pushL(20);
    pushC('length');
    b.emit('GET_PROP');
    pushL(22);
    b.emit('GT');
    const loopBLinesExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(20);
    pushL(22);
    b.emit('GET_PROP');
    callM('trim', 0);
    popL(23); // lineK
    pushL(23);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jLkEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(23);
    pushL(21);
    b.emit('ARRAY_PUSH');
    b.patchJump(jLkEmpty + 1, b.markLabel());

    pushL(22);
    pushC(1);
    b.emit('ADD');
    popL(22);
    b.emit('JUMP', loopBLinesStart);

    b.patchJump(loopBLinesExit + 1, b.markLabel());

    pushL(21);
    pushC('length');
    b.emit('GET_PROP');
    pushC(2);
    b.emit('LT');
    const jValidSrtBlk = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    // skip
    const jNextSrtBlk = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jValidSrtBlk + 1, b.markLabel());

    // find tIdx
    pushC(-1);
    popL(24); // tIdx = -1
    pushC(0);
    popL(25); // tj = 0

    const loopFindTIdxStart = b.markLabel();
    pushL(21);
    pushC('length');
    b.emit('GET_PROP');
    pushL(25);
    b.emit('GT');
    const loopFindTIdxExit = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(21);
    pushL(25);
    b.emit('GET_PROP');
    pushC('-->');
    callM('includes', 1);
    const jIsTimeLine = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(25);
    popL(24);
    b.emit('JUMP', loopFindTIdxExit);
    b.patchJump(jIsTimeLine + 1, b.markLabel());

    pushL(25);
    pushC(1);
    b.emit('ADD');
    popL(25);
    b.emit('JUMP', loopFindTIdxStart);

    b.patchJump(loopFindTIdxExit + 1, b.markLabel());

    pushL(24);
    pushC(-1);
    b.emit('EQ');
    const jTIdxFound = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('JUMP', jNextSrtBlk);
    b.patchJump(jTIdxFound + 1, b.markLabel());

    pushL(21);
    pushL(24);
    b.emit('GET_PROP');
    callVM('normalizeTimeline', 1);
    popL(26); // normBlockTimeline

    pushC(null);
    popL(27); // targetId = null

    // Strategy 1: Timeline map match
    pushL(26);
    pushL(3);
    b.emit('MAP_HAS');
    const jHasTlMatch = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(26);
    pushL(3);
    b.emit('MAP_GET');
    pushC('id');
    b.emit('GET_PROP');
    popL(27);
    b.patchJump(jHasTlMatch + 1, b.markLabel());

    // Strategy 2: ID line fallback
    pushL(27);
    pushC(null);
    b.emit('EQ');
    const jNeedIdFallback = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(24);
    pushC(0);
    b.emit('GT');
    const jHasLineAbove = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(21);
    pushC(0);
    b.emit('GET_PROP');
    pushC(/#?\s*(\d+)/);
    callM('match', 1);
    popL(28); // idMatch
    pushL(28);
    b.emit('IS_TRUTHY');
    const jHasCandMatch = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(28);
    pushC(1);
    b.emit('GET_PROP');
    pushC(10);
    b.emit('GET_GLOBAL', c('parseInt'));
    b.emit('CALL_FUNC', 2);
    popL(29); // candId
    pushL(29);
    pushL(2);
    b.emit('SET_HAS');
    const jCandInExpected = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(3);
    pushC('size');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('EQ');
    const jTlMapEmpty = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(29);
    popL(27);
    const jCandDone = b.markLabel();
    b.emit('JUMP', 0);
    b.patchJump(jTlMapEmpty + 1, b.markLabel());
    pushL(29);
    pushL(4);
    b.emit('MAP_GET');
    popL(30); // expIt
    pushL(30);
    b.emit('IS_TRUTHY');
    const jHasExpIt = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(30);
    pushC('normalizedTimeline');
    b.emit('GET_PROP');
    pushL(26);
    b.emit('EQ');
    const jNormEq = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(29);
    popL(27);
    b.patchJump(jNormEq + 1, b.markLabel());
    b.patchJump(jHasExpIt + 1, b.markLabel());
    b.patchJump(jCandDone + 1, b.markLabel());
    b.patchJump(jCandInExpected + 1, b.markLabel());
    b.patchJump(jHasCandMatch + 1, b.markLabel());
    b.patchJump(jHasLineAbove + 1, b.markLabel());
    b.patchJump(jNeedIdFallback + 1, b.markLabel());

    // If targetId != null and text exists
    pushL(27);
    pushC(null);
    b.emit('NEQ');
    const jHasTarget = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(21);
    pushC('length');
    b.emit('GET_PROP');
    pushL(24);
    pushC(1);
    b.emit('ADD');
    b.emit('GT');
    const jHasTextBelow = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(21);
    pushL(24);
    pushC(1);
    b.emit('ADD');
    callM('slice', 1);
    pushC(' ');
    callM('join', 1);
    callM('trim', 0);
    popL(31); // trans

    pushL(31);
    pushC('length');
    b.emit('GET_PROP');
    pushC(0);
    b.emit('GT');
    const jTransLenGt0 = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(27);
    pushL(1);
    b.emit('GET_PROP');
    b.emit('NOT');
    const jResMapNotYet = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(1);
    pushL(31);
    pushL(27);
    b.emit('SET_PROP');
    b.patchJump(jResMapNotYet + 1, b.markLabel());
    b.patchJump(jTransLenGt0 + 1, b.markLabel());
    b.patchJump(jHasTextBelow + 1, b.markLabel());
    b.patchJump(jHasTarget + 1, b.markLabel());

    b.patchJump(jNextSrtBlk + 1, b.markLabel());

    pushL(19);
    pushC(1);
    b.emit('ADD');
    popL(19);
    b.emit('JUMP', loopSrtBlkStart);

    b.patchJump(loopSrtBlkExit + 1, b.markLabel());
    b.patchJump(jHasSrtBlocks + 1, b.markLabel());

    pushL(1);
    b.emit('RETURN');

    // =========================================================================
    // 16. filterMissingItems(items)
    // =========================================================================
    b.registerFunction('filterMissingItems');
    pushA(0);
    b.emit('IS_TRUTHY');
    b.emit('NOT');
    const jFiltNull = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_ARR', 0);
    b.emit('RETURN');
    b.patchJump(jFiltNull + 1, b.markLabel());

    b.emit('NEW_ARR', 0);
    popL(0); // missing = []
    pushC(0);
    popL(1); // i = 0

    const jFiltLoop = b.markLabel();
    pushL(1);
    pushA(0);
    pushC('length');
    b.emit('GET_PROP');
    b.emit('LT');
    const jFiltEnd = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(1);
    b.emit('GET_PROP');
    popL(2); // it = items[i]

    pushL(2);
    b.emit('IS_TRUTHY');
    const jFiltHasIt = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(2);
    pushC('status');
    b.emit('GET_PROP');
    pushC('completed');
    b.emit('NEQ');
    const jFiltNotComp = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // missing.push(it) -> item first, then arr!
    pushL(2);
    pushL(0);
    b.emit('ARRAY_PUSH');

    b.patchJump(jFiltNotComp + 1, b.markLabel());
    b.patchJump(jFiltHasIt + 1, b.markLabel());

    // i++
    pushL(1);
    pushC(1);
    b.emit('ADD');
    popL(1);
    b.emit('JUMP', jFiltLoop);

    b.patchJump(jFiltEnd + 1, b.markLabel());
    pushL(0);
    b.emit('RETURN');

    // =========================================================================
    // 17. applyRecoveryResults(batchItems, parsedResults, contextItemId)
    // =========================================================================
    b.registerFunction('applyRecoveryResults');
    // Guard 1: !batchItems
    pushA(0);
    b.emit('IS_TRUTHY');
    b.emit('NOT');
    const jNoItems = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP'); pushC(0); pushC('recovered'); b.emit('SET_PROP');
    b.emit('DUP'); pushC(0); pushC('stillMissing'); b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jNoItems + 1, b.markLabel());

    // Guard 2: !parsedResults
    pushA(1);
    b.emit('IS_TRUTHY');
    b.emit('NOT');
    const jNoParsed = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    b.emit('NEW_OBJ');
    b.emit('DUP'); pushC(0); pushC('recovered'); b.emit('SET_PROP');
    b.emit('DUP'); pushC(0); pushC('stillMissing'); b.emit('SET_PROP');
    b.emit('RETURN');
    b.patchJump(jNoParsed + 1, b.markLabel());

    // Step 1: Create itemMap = new Map() (local 0)
    b.emit('NEW_MAP');
    popL(0);

    // Loop i = 0 (local 1)
    pushC(0);
    popL(1);
    const jMapLoop = b.markLabel();
    pushL(1);
    pushA(0);
    pushC('length');
    b.emit('GET_PROP');
    b.emit('LT');
    const jMapEnd = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushA(0);
    pushL(1);
    b.emit('GET_PROP');
    popL(2); // it = batchItems[i]

    pushL(2);
    b.emit('IS_TRUTHY');
    const jMapHasIt = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // itemMap.set(it.id, it)
    pushL(2); // val
    pushL(2); pushC('id'); b.emit('GET_PROP'); // key
    pushL(0); // map
    b.emit('MAP_SET');

    b.patchJump(jMapHasIt + 1, b.markLabel());
    pushL(1); pushC(1); b.emit('ADD'); popL(1);
    b.emit('JUMP', jMapLoop);
    b.patchJump(jMapEnd + 1, b.markLabel());

    // Step 2: keys = Object.keys(parsedResults) (local 3)
    b.emit('GET_GLOBAL', c('Object'));
    pushA(1);
    callM('keys', 1);
    popL(3);

    // Loop k = 0 (local 4)
    pushC(0);
    popL(4);
    const jKeysLoop = b.markLabel();
    pushL(4);
    pushL(3);
    pushC('length');
    b.emit('GET_PROP');
    b.emit('LT');
    const jKeysEnd = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    pushL(3);
    pushL(4);
    b.emit('GET_PROP');
    popL(5); // idStr = keys[k]

    // id = parseInt(idStr, 10) (local 6)
    pushL(5);
    pushC(10);
    b.emit('GET_GLOBAL', c('parseInt'));
    b.emit('CALL_FUNC', 2);
    popL(6);

    // check: if (contextItemId && id === contextItemId) skip
    pushA(2);
    b.emit('IS_TRUTHY');
    const jCheckCtx = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);
    pushL(6);
    pushA(2);
    b.emit('EQ');
    const jIsCtx = b.markLabel();
    b.emit('JUMP_IF_TRUE', 0);
    b.patchJump(jCheckCtx + 1, b.markLabel());

    // it = itemMap.get(id) (local 7)
    pushL(6); // key
    pushL(0); // map
    b.emit('MAP_GET');
    popL(7);

    pushL(7);
    b.emit('IS_TRUTHY');
    const jHasTargetIt = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // trans = parsedResults[idStr] (local 8)
    pushA(1);
    pushL(5);
    b.emit('GET_PROP');
    popL(8);

    // check = isTranslationValid(it.original, trans) (local 9)
    pushL(7); pushC('original'); b.emit('GET_PROP');
    pushL(8);
    callVM('isTranslationValid', 2);
    popL(9);

    pushL(9); pushC('valid'); b.emit('GET_PROP');
    const jTransValid = b.markLabel();
    b.emit('JUMP_IF_FALSE', 0);

    // valid: it.translated = trans; it.status = 'completed'; it.errorReason = null;
    pushL(7); pushL(8); pushC('translated'); b.emit('SET_PROP');
    pushL(7); pushC('completed'); pushC('status'); b.emit('SET_PROP');
    pushL(7); pushC(null); pushC('errorReason'); b.emit('SET_PROP');
    const jTransDone = b.markLabel();
    b.emit('JUMP', 0);

    // invalid: it.status = 'invalid'; it.errorReason = check.reason;
    b.patchJump(jTransValid + 1, b.markLabel());
    pushL(7); pushC('invalid'); pushC('status'); b.emit('SET_PROP');
    pushL(7); pushL(9); pushC('reason'); b.emit('GET_PROP'); pushC('errorReason'); b.emit('SET_PROP');

    b.patchJump(jTransDone + 1, b.markLabel());
    b.patchJump(jHasTargetIt + 1, b.markLabel());
    b.patchJump(jIsCtx + 1, b.markLabel());

    // k++
    pushL(4); pushC(1); b.emit('ADD'); popL(4);
    b.emit('JUMP', jKeysLoop);
    b.patchJump(jKeysEnd + 1, b.markLabel());

    // Step 3: missing = filterMissingItems(batchItems) (local 10)
    pushA(0);
    callVM('filterMissingItems', 1);
    popL(10);

    // Result object: { recovered: batchItems.length - missing.length, stillMissing: missing.length }
    b.emit('NEW_OBJ');
    b.emit('DUP');
    pushA(0); pushC('length'); b.emit('GET_PROP');
    pushL(10); pushC('length'); b.emit('GET_PROP');
    b.emit('SUB');
    pushC('recovered');
    b.emit('SET_PROP');

    b.emit('DUP');
    pushL(10); pushC('length'); b.emit('GET_PROP');
    pushC('stillMissing');
    b.emit('SET_PROP');

    b.emit('RETURN');

    const vmRuntime = generateVmRuntimeCode(b.opMap, b.constants, b.code, b.functionPointers);
    return {
        runtimeCode: vmRuntime,
        constantsCount: b.constants.length,
        bytecodeLength: b.code.length,
        functions: Object.keys(b.functionPointers)
    };
}

function buildUserscript() {
    console.log('[KAGEVIETSUB Build] Compiling SRT Engine to Virtual Machine Bytecode...');
    const compileResult = compileEngine();
    console.log(`[KAGEVIETSUB Build] VM Compilation complete: ${compileResult.bytecodeLength} opcodes, ${compileResult.constantsCount} encrypted constants.`);

    const sourcePath = path.resolve(__dirname, '../src/kagevietsub_mobile.source.js');
    const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

    // Section 4 boundaries:
    const startMarker = '// 4. CÔNG CỤ XỬ LÝ SRT & KIỂM TRA CHẤT LƯỢNG (PORT TỪ PYTHON TOOL PC)';
    const endMarker = '// 5. TƯƠNG TÁC DOM DEEPSEEK (PHÂN BIỆT RÕ PC VÀ MOBILE - MỤC 18)';

    const startIdx = sourceContent.indexOf(startMarker);
    const endIdx = sourceContent.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
        throw new Error('Cannot locate Section 4 boundaries in source file!');
    }

    const bridgeCode = `
    // =========================================================================
    // 4. BỘ ĐIỀU PHỐI VIRTUAL MACHINE (PROTECTED VM ENGINE RUNTIME)
    // =========================================================================
${compileResult.runtimeCode}

    function normalizeTimeline(timelineStr) {
        return _0xvm.call('normalizeTimeline', [timelineStr]);
    }

    function cleanMarkdown(raw) {
        return _0xvm.call('cleanMarkdown', [raw]);
    }

    function normalizeText(text) {
        return _0xvm.call('normalizeText', [text]);
    }

    function containsChinese(text) {
        return _0xvm.call('containsChinese', [text]);
    }

    function countChinese(text) {
        return _0xvm.call('countChinese', [text]);
    }

    function isTranslationValid(original, translated) {
        return _0xvm.call('isTranslationValid', [original, translated]);
    }

    function calculateBatches(items, mode, batchSize) {
        return _0xvm.call('calculateBatches', [items, mode, batchSize]);
    }

    function buildBatchPrompt(activePrompt, batchItems) {
        return _0xvm.call('buildBatchPrompt', [activePrompt, batchItems]);
    }

    function buildRetryPrompt(missingItems) {
        return _0xvm.call('buildRetryPrompt', [missingItems]);
    }

    function buildRecoveryPrompt(activePrompt, contextItem, missingItems) {
        return _0xvm.call('buildRecoveryPrompt', [activePrompt, contextItem, missingItems]);
    }

    function validateTranslationResults(expectedItems, parsedResultMap) {
        return _0xvm.call('validateTranslationResults', [expectedItems, parsedResultMap]);
    }

    function validateFinalExport(items) {
        return _0xvm.call('validateFinalExport', [items]);
    }

    function buildCompleteSrtContent(items) {
        return _0xvm.call('buildCompleteSrtContent', [items]);
    }

    function parseSrtContent(content) {
        return _0xvm.call('parseSrtContent', [content]);
    }

    function parseAiResponse(rawText, expectedInput) {
        return _0xvm.call('parseAiResponse', [rawText, expectedInput]);
    }

    function filterMissingItems(items) {
        return _0xvm.call('filterMissingItems', [items]);
    }

    function applyRecoveryResults(batchItems, parsedResults, contextItemId) {
        return _0xvm.call('applyRecoveryResults', [batchItems, parsedResults, contextItemId]);
    }

    // =========================================================================\n    `;

    const preSection = sourceContent.substring(0, sourceContent.lastIndexOf('\n', startIdx));
    const postSection = sourceContent.substring(sourceContent.lastIndexOf('// =========================================================================', endIdx));

    const finalUserscript = preSection + '\n' + bridgeCode + postSection;

    // Strict validation: Ensure NO duplicate declarations of protected functions exist anywhere
    const protectedFunctions = [
        'normalizeTimeline', 'cleanMarkdown', 'normalizeText', 'containsChinese', 'countChinese',
        'isTranslationValid', 'calculateBatches', 'buildBatchPrompt', 'buildRetryPrompt',
        'buildRecoveryPrompt', 'validateTranslationResults', 'validateFinalExport',
        'buildCompleteSrtContent', 'parseSrtContent', 'parseAiResponse',
        'filterMissingItems', 'applyRecoveryResults'
    ];
    for (const fn of protectedFunctions) {
        const matches = [...finalUserscript.matchAll(new RegExp(`function\\s+${fn}\\s*\\(`, 'g'))];
        if (matches.length !== 1) {
            throw new Error(`Security Violation: '${fn}' has ${matches.length} declarations in output userscript! Must be exactly 1.`);
        }
    }
    console.log(`[KAGEVIETSUB Build] Verified all ${protectedFunctions.length} protected functions have exactly 1 declaration (VM bridge only).`);

    // Output target 1: tampermonkey/kagevietsub_mobile.user.js
    const outPath1 = path.resolve(__dirname, '../kagevietsub_mobile.user.js');
    fs.writeFileSync(outPath1, finalUserscript, 'utf-8');
    console.log(`[KAGEVIETSUB Build] Output written to: ${outPath1}`);

    // Output target 2: tool dt/kagevietsub_mobile.user.js (mirror)
    const outPath2 = path.resolve('C:/Users/admin/Documents/video/tool/tool dt/kagevietsub_mobile.user.js');
    try {
        fs.writeFileSync(outPath2, finalUserscript, 'utf-8');
        console.log(`[KAGEVIETSUB Build] Output mirrored to: ${outPath2}`);
    } catch (e) {
        console.warn(`[KAGEVIETSUB Build] Mirror to ${outPath2} skipped: ${e.message}`);
    }

    return { outPath1, outPath2, compileResult };
}

if (require.main === module) {
    buildUserscript();
}

module.exports = {
    compileEngine,
    buildUserscript
};
